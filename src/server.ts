/**
 * Local-First HTTP Server (`src/server.ts`)
 * Serves the CreativeID Studio UI, the local persona API (./api.ts) and the
 * built-in ATProto / Solid sandboxes used for zero-config publishing tests.
 * Binds to 127.0.0.1 only (see index.ts).
 */

import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { ATPROTO_COLLECTION_NSID } from "./schema.js";
import { PersonaLibrary } from "./library.js";
import { handleApi } from "./api.js";

export interface ServerOptions {
  /** Persona store; defaults to <project>/data/personas. */
  library?: PersonaLibrary;
  /** v1 single-persona file to import on first run; defaults to <project>/data/persona.jsonld. */
  legacyV1Path?: string;
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

export function createStudioServer(options: ServerOptions = {}): Server {
  const __dirname = fileURLToPath(new URL(".", import.meta.url));
  const projectRoot = resolve(__dirname, "..");
  const dataDir = join(projectRoot, "data");
  const library = options.library ?? new PersonaLibrary(join(dataDir, "personas"));
  const legacyV1Path = options.legacyV1Path ?? join(dataDir, "persona.jsonld");
  const exportDir = options.exportDir ?? join(dataDir, "exports");
  const publicDir = options.publicDir ?? join(projectRoot, "public");
  const fetchImpl = options.fetchImpl ?? fetch;

  // Import an old single-persona file once, before the first request is served.
  const ready = library
    .migrateV1(legacyV1Path)
    .then((migrated) => {
      if (migrated) {
        console.log(
          `Imported v1 persona as "${migrated.personaId}" (original kept at ${migrated.backupPath}).`
        );
      }
    })
    .catch((err) => {
      console.error(`Could not import v1 persona from ${legacyV1Path}:`, err);
    });

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
      await ready;
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
      // 3. CreativeID Local API (/api/*) — see ./api.ts
      // -----------------------------------------------------------------------
      if (await handleApi({ library, exportDir, fetchImpl }, req, res, url)) {
        return;
      }

      // -----------------------------------------------------------------------
      // 4. Static Frontend Assets (public/*)
      // -----------------------------------------------------------------------
      if (method === "GET") {
        const assetPath = pathname === "/" ? "/index.html" : pathname;
        const resolvedAsset = resolve(publicDir, `.${assetPath}`);
        if (resolvedAsset !== publicDir && !resolvedAsset.startsWith(publicDir + sep)) {
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
