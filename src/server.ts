/**
 * Local-First HTTP Server & API (`src/server.ts`)
 * Serves the Creative Passport browser UI, local persona CRUD API,
 * protocol publishing endpoints, and built-in local ATProto/Solid sandboxes.
 */

import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ATPROTO_COLLECTION_NSID,
  CanonicalPersona,
  createCanonicalPersona,
  validatePersonaInput,
} from "./schema.js";
import { PersonaStore } from "./store.js";
import {
  toAtprotoRecord,
  toPublicJsonLd,
  toSolidTurtle,
} from "./transformers.js";
import {
  publishStaticExport,
  serializeStaticExport,
  StaticExportFormat,
} from "./adapters/static.js";
import { publishToAtproto } from "./adapters/atproto.js";
import { publishToSolid, SolidDocumentFormat } from "./adapters/solid.js";

export interface ServerOptions {
  store?: PersonaStore;
  exportDir?: string;
  publicDir?: string;
  fetchImpl?: typeof fetch;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    return {} as T;
  }
  return JSON.parse(raw) as T;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function buildPreviews(persona: CanonicalPersona | null) {
  const target =
    persona ??
    createCanonicalPersona({
      name: "Your Persona Name",
      biography: "Write your creative biography or artistic statement here.",
    });

  return {
    canonicalJsonLd: persona,
    publicJsonLd: toPublicJsonLd(target),
    atprotoRecord: toAtprotoRecord(target),
    solidTurtle: toSolidTurtle(target),
  };
}

export function createPassportServer(options: ServerOptions = {}): Server {
  const __dirname = fileURLToPath(new URL(".", import.meta.url));
  const projectRoot = resolve(__dirname, "..");
  const store =
    options.store ?? new PersonaStore(join(projectRoot, "data", "persona.jsonld"));
  const exportDir = options.exportDir ?? join(projectRoot, "data", "exports");
  const publicDir = options.publicDir ?? join(projectRoot, "public");
  const fetchImpl = options.fetchImpl ?? fetch;

  // Built-in local sandbox stores for zero-config testing of ATProto and Solid publishing
  const sandboxAtprotoRecords = new Map<
    string,
    { uri: string; cid: string; value: unknown }
  >();
  const sandboxSolidResources = new Map<
    string,
    { contentType: string; content: string }
  >();

  return createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? "localhost:3000";
      const url = new URL(req.url ?? "/", `http://${host}`);
      const pathname = url.pathname;
      const method = req.method ?? "GET";

      // -----------------------------------------------------------------------
      // 1. Built-in Local ATProto PDS Sandbox (/sandbox/atproto/xrpc/*)
      // -----------------------------------------------------------------------
      if (
        pathname === "/sandbox/atproto/xrpc/com.atproto.server.createSession" &&
        method === "POST"
      ) {
        const body = await readJsonBody<{ identifier?: string; password?: string }>(
          req
        );
        const handle = (body.identifier || "creator.local.test").trim();
        const slug = handle.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "local";
        const did = handle.startsWith("did:") ? handle : `did:plc:sandbox${slug}`;
        return sendJson(res, 200, {
          did,
          handle,
          accessJwt: `sandbox-jwt-${slug}`,
        });
      }

      if (
        pathname === "/sandbox/atproto/xrpc/com.atproto.repo.putRecord" &&
        method === "POST"
      ) {
        const body = await readJsonBody<{
          repo: string;
          collection: string;
          rkey: string;
          record: unknown;
        }>(req);
        const key = `${body.repo}/${body.collection || ATPROTO_COLLECTION_NSID}/${body.rkey || "self"}`;
        const uri = `at://${key}`;
        const cid = `bafyreisandbox${Date.now().toString(36)}`;
        sandboxAtprotoRecords.set(key, { uri, cid, value: body.record });
        return sendJson(res, 200, { uri, cid });
      }

      if (
        pathname === "/sandbox/atproto/xrpc/com.atproto.repo.getRecord" &&
        method === "GET"
      ) {
        const repo = url.searchParams.get("repo") ?? "";
        const collection =
          url.searchParams.get("collection") ?? ATPROTO_COLLECTION_NSID;
        const rkey = url.searchParams.get("rkey") ?? "self";
        const found = sandboxAtprotoRecords.get(`${repo}/${collection}/${rkey}`);
        if (!found) {
          return sendJson(res, 404, { error: "RecordNotFound" });
        }
        return sendJson(res, 200, found);
      }

      // -----------------------------------------------------------------------
      // 2. Built-in Local Solid Pod Sandbox (/sandbox/solid/*)
      // -----------------------------------------------------------------------
      if (pathname.startsWith("/sandbox/solid/")) {
        if (method === "PUT") {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const content = Buffer.concat(chunks).toString("utf8");
          const contentType =
            req.headers["content-type"] ?? "text/turtle; charset=utf-8";
          sandboxSolidResources.set(pathname, { contentType, content });
          res.writeHead(201, {
            "Content-Type": "text/plain; charset=utf-8",
            Location: pathname,
          });
          res.end("Created");
          return;
        }

        if (method === "GET") {
          const resource = sandboxSolidResources.get(pathname);
          if (!resource) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Solid sandbox resource not found");
            return;
          }
          res.writeHead(200, { "Content-Type": resource.contentType });
          res.end(resource.content);
          return;
        }
      }

      // -----------------------------------------------------------------------
      // 3. Creative Passport Local API (/api/*)
      // -----------------------------------------------------------------------
      if (pathname === "/api/persona" && method === "GET") {
        const persona = await store.load();
        return sendJson(res, 200, {
          persona,
          filePath: store.filePath,
          previews: buildPreviews(persona),
        });
      }

      if (pathname === "/api/persona" && method === "PUT") {
        const body = await readJsonBody<{
          name?: string;
          biography?: string;
          id?: string;
        }>(req);

        const validation = validatePersonaInput({
          name: body.name ?? "",
          biography: body.biography ?? "",
          id: body.id,
        });

        if (!validation.valid) {
          return sendJson(res, 400, {
            error: "Validation failed",
            issues: validation.issues,
          });
        }

        const saved = await store.upsert({
          name: body.name ?? "",
          biography: body.biography ?? "",
          id: body.id,
        });

        return sendJson(res, 200, {
          persona: saved,
          filePath: store.filePath,
          previews: buildPreviews(saved),
        });
      }

      if (pathname === "/api/export/download" && method === "GET") {
        const persona = await store.load();
        if (!persona) {
          return sendJson(res, 404, {
            error: "No local persona exists yet. Save your persona first.",
          });
        }

        const format: StaticExportFormat =
          url.searchParams.get("format") === "turtle" ? "turtle" : "jsonld";
        const publicUrl = url.searchParams.get("publicUrl") || undefined;
        const { contentType, content } = serializeStaticExport(
          persona,
          format,
          publicUrl
        );
        const filename =
          format === "turtle" ? "passport.ttl" : "passport.jsonld";

        res.writeHead(200, {
          "Content-Type": `${contentType}; charset=utf-8`,
          "Content-Disposition": `attachment; filename="${filename}"`,
        });
        res.end(content);
        return;
      }

      if (pathname === "/api/publish/static" && method === "POST") {
        const persona = await store.load();
        if (!persona) {
          return sendJson(res, 400, {
            error: "Save your persona locally before publishing.",
          });
        }

        const body = await readJsonBody<{
          format?: StaticExportFormat;
          publicUrl?: string;
          filename?: string;
        }>(req);

        const format: StaticExportFormat =
          body.format === "turtle" ? "turtle" : "jsonld";
        const defaultFilename =
          format === "turtle" ? "passport.ttl" : "passport.jsonld";
        const safeFilename = (body.filename || defaultFilename).replace(
          /[^a-zA-Z0-9._-]/g,
          "_"
        );
        const outputPath = join(exportDir, safeFilename);

        const result = await publishStaticExport(persona, {
          outputPath,
          format,
          publicUrl: body.publicUrl,
        });

        const updatedPersona = await store.recordPublication(
          "static",
          result.status
        );

        return sendJson(res, 200, {
          result,
          persona: updatedPersona,
          previews: buildPreviews(updatedPersona),
        });
      }

      if (pathname === "/api/publish/atproto" && method === "POST") {
        const persona = await store.load();
        if (!persona) {
          return sendJson(res, 400, {
            error: "Save your persona locally before publishing to AT Protocol.",
          });
        }

        const body = await readJsonBody<{
          pdsUrl?: string;
          identifier?: string;
          password?: string;
          accessJwt?: string;
        }>(req);

        if (!body.pdsUrl || !body.identifier) {
          return sendJson(res, 400, {
            error: "Both pdsUrl and identifier (handle or DID) are required.",
          });
        }

        const result = await publishToAtproto(persona, {
          pdsUrl: body.pdsUrl,
          identifier: body.identifier,
          password: body.password,
          accessJwt: body.accessJwt,
          fetchImpl,
        });

        const updatedPersona = await store.recordPublication(
          "atproto",
          result.status
        );

        return sendJson(res, 200, {
          result,
          persona: updatedPersona,
          previews: buildPreviews(updatedPersona),
        });
      }

      if (pathname === "/api/publish/solid" && method === "POST") {
        const persona = await store.load();
        if (!persona) {
          return sendJson(res, 400, {
            error: "Save your persona locally before publishing to a Solid Pod.",
          });
        }

        const body = await readJsonBody<{
          resourceUrl?: string;
          format?: SolidDocumentFormat;
          authToken?: string;
          authScheme?: "Bearer" | "DPoP";
        }>(req);

        if (!body.resourceUrl) {
          return sendJson(res, 400, {
            error: "Solid Pod resourceUrl is required.",
          });
        }

        const result = await publishToSolid(persona, {
          resourceUrl: body.resourceUrl,
          format: body.format,
          authToken: body.authToken,
          authScheme: body.authScheme,
          fetchImpl,
        });

        const updatedPersona = await store.recordPublication(
          "solid",
          result.status
        );

        return sendJson(res, 200, {
          result,
          persona: updatedPersona,
          previews: buildPreviews(updatedPersona),
        });
      }

      // -----------------------------------------------------------------------
      // 4. Static Frontend Assets (public/*)
      // -----------------------------------------------------------------------
      if (method === "GET") {
        const assetPath = pathname === "/" ? "/index.html" : pathname;
        const resolvedAsset = resolve(publicDir, `.${assetPath}`);
        if (!resolvedAsset.startsWith(publicDir)) {
          res.writeHead(403);
          res.end("Forbidden");
          return;
        }

        try {
          const content = await readFile(resolvedAsset);
          const ext = extname(resolvedAsset);
          const mime = MIME_TYPES[ext] ?? "application/octet-stream";
          res.writeHead(200, {
            "Content-Type": mime,
            "Cache-Control": "no-cache",
          });
          res.end(content);
          return;
        } catch {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not Found");
          return;
        }
      }

      sendJson(res, 404, { error: "Endpoint not found" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: message });
    }
  });
}
