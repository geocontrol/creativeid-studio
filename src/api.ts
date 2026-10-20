/**
 * Local persona API (`src/api.ts`).
 *
 *   GET    /api/personas                                   list
 *   POST   /api/personas                                   create (ProfileInput)
 *   GET    /api/personas/:id                               one persona, with previews
 *   PUT    /api/personas/:id                               replace profile (ProfileInput)
 *   DELETE /api/personas/:id                               move to .trash
 *   POST   /api/personas/:id/works                         add (WorkInput)
 *   PUT    /api/personas/:id/works/:workId                 replace
 *   DELETE /api/personas/:id/works/:workId                 remove
 *   POST   /api/personas/:id/connections                   add (ConnectionInput)
 *   PUT    /api/personas/:id/connections/:connId           replace
 *   DELETE /api/personas/:id/connections/:connId           remove
 *   PUT    /api/personas/:id/private                       { key, value } — never published
 *   GET    /api/personas/:id/preview                       JSON-LD, Turtle and ATProto records
 *   GET    /api/personas/:id/export/download?format=jsonld|turtle&publicUrl=
 *   GET    /api/personas/:id/publish/atproto/plan          what an ATProto publish would change
 *   POST   /api/personas/:id/publish/{static,atproto,solid}
 *
 * Legacy single-persona routes for the v1 UI, acting on the first persona
 * (removed in M5): GET/PUT /api/persona, GET /api/export/download,
 * POST /api/publish/{static,atproto,solid}.
 *
 * Only the publish routes touch the network.
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import { PersonaFileDamaged, PersonaLibrary, PersonaNotFound } from "./library.js";
import {
  addConnection,
  addWork,
  ConnectionInput,
  createPersonaDocument,
  getConnections,
  getProfile,
  getWorks,
  localIdOf,
  PersonaDocument,
  PersonaNotFoundError,
  PersonaValidationError,
  ProfileInput,
  PublicationsV2,
  removeConnection,
  removeWork,
  setPrivateField,
  toConnectionInput,
  toProfileInput,
  toWorkInput,
  updateConnection,
  updateProfile,
  updateWork,
  validateDocument,
  WorkInput,
} from "./model/index.js";
import { planPublish, RecordValidationError, toAtprotoRecords } from "./atproto/records.js";
import { serializePersona, toPublicJsonLd, toTurtle } from "./rdf.js";
import { publishStaticExport, StaticExportFormat } from "./adapters/static.js";
import {
  AccountMismatchError,
  applyAtprotoResult,
  publishPersona,
  PublishFailedError,
} from "./adapters/atproto.js";
import { publishToSolid, SolidDocumentFormat } from "./adapters/solid.js";

export interface ApiContext {
  library: PersonaLibrary;
  exportDir: string;
  fetchImpl: typeof fetch;
}

class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly extra: object = {}) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Request / response helpers
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 1_000_000;

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large.");
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpError(400, "Request body is not valid JSON.");
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload, null, 2));
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** A persona as the API returns it: plain inputs plus ids and dates, no JSON-LD keys. */
export function personaView(doc: PersonaDocument, library: PersonaLibrary) {
  const profile = getProfile(doc);
  return {
    personaId: doc["creativeid:personaId"],
    filePath: library.pathFor(doc["creativeid:personaId"]),
    profile: toProfileInput(profile),
    dateCreated: profile.dateCreated,
    dateModified: profile.dateModified,
    works: getWorks(doc).map((w) => ({
      id: localIdOf(w),
      ...toWorkInput(w),
      dateCreated: w.dateCreated,
      dateModified: w.dateModified,
    })),
    connections: getConnections(doc).map((c) => ({
      id: localIdOf(c),
      ...toConnectionInput(c),
      dateCreated: c.dateCreated,
      dateModified: c.dateModified,
    })),
    private: doc["creativeid:private"],
    publications: doc["creativeid:publications"],
    warnings: validateDocument(doc).warnings,
  };
}

/** Everything a persona would publish, in each format. */
export function previewsFor(doc: PersonaDocument) {
  return {
    jsonld: toPublicJsonLd(doc),
    turtle: toTurtle(doc),
    atproto: toAtprotoRecords(doc).map(({ collection, rkey, record }) => ({ collection, rkey, record })),
  };
}

// --- shapes the v1 UI expects (removed in M5) ---------------------------------

function legacyPublications(pubs: PublicationsV2) {
  const out: Record<string, { uri: string; cid?: string; publishedAt: string }> = {};
  const me = pubs.atproto?.records?.me;
  if (me) out.atproto = { uri: me.uri, ...(me.cid ? { cid: me.cid } : {}), publishedAt: me.publishedAt };
  if (pubs.solid) out.solid = { ...pubs.solid };
  if (pubs.static) out.static = { ...pubs.static };
  return out;
}

function legacyPersona(doc: PersonaDocument) {
  const p = getProfile(doc);
  return {
    "@id": "#me",
    name: p.name,
    description: p.description ?? "",
    dateCreated: p.dateCreated,
    dateModified: p.dateModified,
    "creativeid:publications": legacyPublications(doc["creativeid:publications"]),
  };
}

function legacyPreviews(doc: PersonaDocument) {
  const previews = previewsFor(doc);
  return {
    publicJsonLd: previews.jsonld,
    atprotoRecord: previews.atproto.map((r) => r.record),
    solidTurtle: previews.turtle,
  };
}

function placeholderPreviews() {
  return legacyPreviews(
    createPersonaDocument(
      { name: "Your Persona Name", bio: "Write your creative biography or artistic statement here." },
      { personaId: "preview" }
    )
  );
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

type Target = "static" | "atproto" | "solid";

async function publish(ctx: ApiContext, personaId: string, target: Target, req: IncomingMessage) {
  const { library } = ctx;
  const doc = await library.require(personaId);

  if (target === "static") {
    const body = await readJsonBody<{ format?: StaticExportFormat; publicUrl?: string; filename?: string }>(req);
    const format: StaticExportFormat = body.format === "turtle" ? "turtle" : "jsonld";
    const fallback = format === "turtle" ? "creativeid.ttl" : "creativeid.jsonld";
    const filename = (body.filename || fallback).replace(/[^a-zA-Z0-9._-]/g, "_");
    const result = await publishStaticExport(doc, {
      outputPath: join(ctx.exportDir, personaId, filename),
      format,
      publicUrl: body.publicUrl,
    });
    const saved = await library.recordPublication(personaId, (p) => ({ ...p, static: result.status }));
    return { result, doc: saved };
  }

  if (target === "atproto") {
    const body = await readJsonBody<{ pdsUrl?: string; identifier?: string; password?: string; accessJwt?: string }>(req);
    if (!body.pdsUrl || !body.identifier) {
      throw new HttpError(400, "Both pdsUrl and identifier (handle or DID) are required.");
    }
    // One account per persona: refuse an account another persona already publishes to.
    const assertAccount = async (did: string) => {
      for (const s of await library.list()) {
        if (s.personaId === personaId) continue;
        const other = await library.get(s.personaId);
        if (other?.["creativeid:publications"].atproto?.did === did) {
          throw new HttpError(409, `That account (${did}) already publishes the persona "${s.name}". Each persona needs its own account.`);
        }
      }
    };
    try {
      const result = await publishPersona(doc, {
        pdsUrl: body.pdsUrl,
        identifier: body.identifier,
        password: body.password,
        accessJwt: body.accessJwt,
        fetchImpl: ctx.fetchImpl,
        assertAccount,
      });
      const saved = await library.recordPublication(personaId, (p) => applyAtprotoResult(p, result));
      return { result, doc: saved };
    } catch (err) {
      if (err instanceof PublishFailedError) {
        // Keep whatever did reach the PDS, so local state matches it.
        await library.recordPublication(personaId, (p) => applyAtprotoResult(p, err.partial));
        throw new HttpError(502, err.message, { partial: err.partial });
      }
      throw err;
    }
  }

  const body = await readJsonBody<{
    resourceUrl?: string;
    format?: SolidDocumentFormat;
    authToken?: string;
    authScheme?: "Bearer" | "DPoP";
  }>(req);
  if (!body.resourceUrl) throw new HttpError(400, "Solid Pod resourceUrl is required.");
  const result = await publishToSolid(doc, {
    resourceUrl: body.resourceUrl,
    format: body.format,
    authToken: body.authToken,
    authScheme: body.authScheme,
    fetchImpl: ctx.fetchImpl,
  });
  const saved = await library.recordPublication(personaId, (p) => ({ ...p, solid: result.status }));
  return { result, doc: saved };
}

function sendDownload(res: ServerResponse, doc: PersonaDocument, url: URL) {
  const format: StaticExportFormat = ["turtle", "ttl"].includes(url.searchParams.get("format") ?? "")
    ? "turtle"
    : "jsonld";
  const publicUrl = url.searchParams.get("publicUrl") || undefined;
  const { contentType, content } = serializePersona(doc, format, publicUrl);
  const filename = format === "turtle" ? "creativeid.ttl" : "creativeid.jsonld";
  res.writeHead(200, {
    "Content-Type": `${contentType}; charset=utf-8`,
    "Content-Disposition": `attachment; filename="${filename}"`,
  });
  res.end(content);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const P = "/api/personas";
const ID = "([^/]+)";
const routes = {
  collection: new RegExp(`^${P}$`),
  persona: new RegExp(`^${P}/${ID}$`),
  works: new RegExp(`^${P}/${ID}/works$`),
  work: new RegExp(`^${P}/${ID}/works/${ID}$`),
  connections: new RegExp(`^${P}/${ID}/connections$`),
  connection: new RegExp(`^${P}/${ID}/connections/${ID}$`),
  private: new RegExp(`^${P}/${ID}/private$`),
  preview: new RegExp(`^${P}/${ID}/preview$`),
  download: new RegExp(`^${P}/${ID}/export/download$`),
  publish: new RegExp(`^${P}/${ID}/publish/(static|atproto|solid)$`),
  plan: new RegExp(`^${P}/${ID}/publish/atproto/plan$`),
  legacyPublish: /^\/api\/publish\/(static|atproto|solid)$/,
};

/**
 * Handles /api/* requests. Returns false when the path is not an API route,
 * so the caller can fall through to static assets.
 */
export async function handleApi(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith("/api/")) return false;
  const method = req.method ?? "GET";
  const { library } = ctx;
  const view = (doc: PersonaDocument) => personaView(doc, library);
  let m: RegExpMatchArray | null;

  try {
    // --- collection --------------------------------------------------------
    if ((m = path.match(routes.collection))) {
      if (method === "GET") {
        sendJson(res, 200, { personas: await library.list(), root: library.root });
        return true;
      }
      if (method === "POST") {
        const doc = await library.create(await readJsonBody<ProfileInput>(req));
        sendJson(res, 201, { persona: view(doc), previews: previewsFor(doc) });
        return true;
      }
    }

    // --- one persona -------------------------------------------------------
    if ((m = path.match(routes.persona))) {
      const id = decodeURIComponent(m[1]);
      if (method === "GET") {
        const doc = await library.require(id);
        sendJson(res, 200, { persona: view(doc), previews: previewsFor(doc) });
        return true;
      }
      if (method === "PUT") {
        const input = await readJsonBody<ProfileInput>(req);
        const doc = await library.update(id, (d) => updateProfile(d, input));
        sendJson(res, 200, { persona: view(doc), previews: previewsFor(doc) });
        return true;
      }
      if (method === "DELETE") {
        const trashedTo = await library.delete(id);
        sendJson(res, 200, { deleted: id, trashedTo });
        return true;
      }
    }

    // --- works -------------------------------------------------------------
    if ((m = path.match(routes.works)) && method === "POST") {
      const id = decodeURIComponent(m[1]);
      const input = await readJsonBody<WorkInput>(req);
      let workId = "";
      const doc = await library.update(id, (d) => {
        const added = addWork(d, input);
        workId = added.id;
        return added.document;
      });
      sendJson(res, 201, { id: workId, persona: view(doc) });
      return true;
    }
    if ((m = path.match(routes.work))) {
      const [id, workId] = [decodeURIComponent(m[1]), decodeURIComponent(m[2])];
      if (method === "PUT") {
        const input = await readJsonBody<WorkInput>(req);
        const doc = await library.update(id, (d) => updateWork(d, workId, input));
        sendJson(res, 200, { id: workId, persona: view(doc) });
        return true;
      }
      if (method === "DELETE") {
        const doc = await library.update(id, (d) => removeWork(d, workId));
        sendJson(res, 200, { deleted: workId, persona: view(doc) });
        return true;
      }
    }

    // --- connections -------------------------------------------------------
    if ((m = path.match(routes.connections)) && method === "POST") {
      const id = decodeURIComponent(m[1]);
      const input = await readJsonBody<ConnectionInput>(req);
      let connId = "";
      let warnings: unknown[] = [];
      const doc = await library.update(id, (d) => {
        const added = addConnection(d, input);
        connId = added.id;
        warnings = added.warnings;
        return added.document;
      });
      sendJson(res, 201, { id: connId, warnings, persona: view(doc) });
      return true;
    }
    if ((m = path.match(routes.connection))) {
      const [id, connId] = [decodeURIComponent(m[1]), decodeURIComponent(m[2])];
      if (method === "PUT") {
        const input = await readJsonBody<ConnectionInput>(req);
        const doc = await library.update(id, (d) => updateConnection(d, connId, input));
        sendJson(res, 200, { id: connId, persona: view(doc) });
        return true;
      }
      if (method === "DELETE") {
        const doc = await library.update(id, (d) => removeConnection(d, connId));
        sendJson(res, 200, { deleted: connId, persona: view(doc) });
        return true;
      }
    }

    // --- private fields ----------------------------------------------------
    if ((m = path.match(routes.private)) && method === "PUT") {
      const id = decodeURIComponent(m[1]);
      const body = await readJsonBody<{ key?: string; value?: string }>(req);
      const doc = await library.update(id, (d) => setPrivateField(d, body.key ?? "", body.value));
      sendJson(res, 200, { persona: view(doc) });
      return true;
    }

    // --- outputs -----------------------------------------------------------
    if ((m = path.match(routes.preview)) && method === "GET") {
      const doc = await library.require(decodeURIComponent(m[1]));
      sendJson(res, 200, { previews: previewsFor(doc) });
      return true;
    }
    if ((m = path.match(routes.download)) && method === "GET") {
      sendDownload(res, await library.require(decodeURIComponent(m[1])), url);
      return true;
    }
    if ((m = path.match(routes.plan)) && method === "GET") {
      const plan = planPublish(await library.require(decodeURIComponent(m[1])));
      const brief = (r: { localId: string; collection: string; rkey: string }) => ({
        localId: r.localId,
        collection: r.collection,
        rkey: r.rkey,
      });
      sendJson(res, 200, {
        create: plan.create.map(brief),
        update: plan.update.map(brief),
        unchanged: plan.unchanged.map(brief),
        delete: plan.delete,
      });
      return true;
    }
    if ((m = path.match(routes.publish)) && method === "POST") {
      const id = decodeURIComponent(m[1]);
      const { result, doc } = await publish(ctx, id, m[2] as Target, req);
      sendJson(res, 200, { result, persona: view(doc), previews: previewsFor(doc) });
      return true;
    }

    // --- legacy single-persona routes (v1 UI; removed in M5) ---------------
    const first = async () => (await library.list())[0]?.personaId;

    if (path === "/api/persona" && method === "GET") {
      const id = await first();
      if (!id) {
        sendJson(res, 200, { persona: null, filePath: library.root, previews: placeholderPreviews() });
        return true;
      }
      const doc = await library.require(id);
      sendJson(res, 200, { persona: legacyPersona(doc), filePath: library.pathFor(id), previews: legacyPreviews(doc) });
      return true;
    }
    if (path === "/api/persona" && method === "PUT") {
      const body = await readJsonBody<{ name?: string; biography?: string }>(req);
      const id = await first();
      const doc = id
        ? await library.update(id, (d) =>
            // Keep everything the old UI can't see (disciplines, links…); change name and bio only.
            updateProfile(d, { ...toProfileInput(getProfile(d)), name: body.name ?? "", bio: body.biography })
          )
        : await library.create({ name: body.name ?? "", bio: body.biography });
      sendJson(res, 200, {
        persona: legacyPersona(doc),
        filePath: library.pathFor(doc["creativeid:personaId"]),
        previews: legacyPreviews(doc),
      });
      return true;
    }
    if (path === "/api/export/download" && method === "GET") {
      const id = await first();
      if (!id) throw new HttpError(404, "No local persona exists yet. Save your persona first.");
      sendDownload(res, await library.require(id), url);
      return true;
    }
    if ((m = path.match(routes.legacyPublish)) && method === "POST") {
      const id = await first();
      if (!id) throw new HttpError(400, "Save your persona locally before publishing.");
      const { result, doc } = await publish(ctx, id, m[1] as Target, req);
      sendJson(res, 200, { result, persona: legacyPersona(doc), previews: legacyPreviews(doc) });
      return true;
    }

    throw new HttpError(404, "Endpoint not found");
  } catch (err) {
    if (err instanceof HttpError) {
      sendJson(res, err.status, { error: err.message, ...err.extra });
    } else if (err instanceof AccountMismatchError) {
      sendJson(res, 409, { error: err.message, boundDid: err.boundDid, sessionDid: err.sessionDid });
    } else if (err instanceof RecordValidationError) {
      sendJson(res, 400, { error: err.message });
    } else if (err instanceof PersonaValidationError) {
      sendJson(res, 400, { error: "Validation failed", issues: err.issues });
    } else if (err instanceof PersonaNotFound || err instanceof PersonaNotFoundError) {
      sendJson(res, 404, { error: err.message });
    } else if (err instanceof PersonaFileDamaged) {
      sendJson(res, 422, { error: err.message, filePath: err.filePath, issues: err.issues });
    } else {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }
}

