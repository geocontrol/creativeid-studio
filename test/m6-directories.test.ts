import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { createServer, Server } from "node:http";

import { createStudioServer, PersonaLibrary } from "../src/index.js";

describe("M6 · telling directories when you publish", () => {
  let dir: string;
  let studio: Server;
  let directory: Server;
  let base: string;
  let dirUrl: string;
  const received: { uri: string; pdsUrl?: string }[] = [];

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "creativeid-dirs-"));
    // A stand-in aggregator that records what it was told.
    directory = createServer(async (req, res) => {
      let body = "";
      for await (const c of req) body += c;
      if (req.url === "/v1/index" && req.method === "POST") received.push(JSON.parse(body));
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ indexed: true }));
    });
    studio = createStudioServer({ library: new PersonaLibrary(join(dir, "data", "personas")), exportDir: join(dir, "exports"), legacyV1Path: join(dir, "none") });
    await new Promise<void>((r) => directory.listen(0, "127.0.0.1", () => r()));
    await new Promise<void>((r) => studio.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(studio.address() as AddressInfo).port}`;
    dirUrl = `http://127.0.0.1:${(directory.address() as AddressInfo).port}`;
  });

  after(async () => {
    for (const s of [studio, directory]) await new Promise<void>((r) => s.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  });

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: (await res.json()) as any };
  };

  it("tells nobody by default, and validates the list", async () => {
    assert.deepEqual((await call("GET", "/api/settings")).json, { indexes: [] });
    assert.equal((await call("PUT", "/api/settings", { indexes: ["not a url"] })).status, 400);
    assert.equal((await call("PUT", "/api/settings", { indexes: Array.from({ length: 6 }, (_, i) => `https://d${i}.example`) })).status, 400);
    const ok = await call("PUT", "/api/settings", { indexes: [`${dirUrl}/`, `${dirUrl}`] });
    assert.deepEqual(ok.json.indexes, [dirUrl], "trailing slash trimmed, duplicates merged");
    const saved = JSON.parse(await readFile(join(dir, "data", "settings.json"), "utf8"));
    assert.deepEqual(saved.indexes, [dirUrl], "kept beside the personas, not in the project");
  });

  it("tells each directory where to find the persona after a publish", async () => {
    const id = (await call("POST", "/api/personas", { name: "Directory Test" })).json.persona.personaId;

    const at = await call("POST", `/api/personas/${id}/publish/atproto`, {
      pdsUrl: `${base}/sandbox/atproto`,
      identifier: "dirtest.creativeid.local",
      password: "x",
    });
    assert.equal(at.status, 200);
    assert.deepEqual(at.json.indexes, [{ index: dirUrl, ok: true }]);
    assert.deepEqual(received.at(-1), {
      uri: "at://did:plc:sandboxdirtestcreativeidlocal/com.cultureblocs.creative.profile/self",
      pdsUrl: `${base}/sandbox/atproto`,
      handle: "dirtest.creativeid.local",
    });

    const solidUrl = `${base}/sandbox/solid/${id}/creativeid.ttl`;
    const solid = await call("POST", `/api/personas/${id}/publish/solid`, { resourceUrl: solidUrl });
    assert.deepEqual(received.at(-1), { uri: solidUrl });
    assert.equal(solid.json.indexes[0].ok, true);

    const before = received.length;
    const local = await call("POST", `/api/personas/${id}/publish/static`, {});
    assert.deepEqual(local.json.indexes, [], "a file with no public address isn't announced");
    assert.equal(received.length, before);

    await call("POST", `/api/personas/${id}/publish/static`, { publicUrl: "https://dirtest.example/.well-known/creativeid.jsonld" });
    assert.deepEqual(received.at(-1), { uri: "https://dirtest.example/.well-known/creativeid.jsonld" });
  });

  it("a directory that's down is reported, and the publish still succeeds", async () => {
    await call("PUT", "/api/settings", { indexes: [dirUrl, "http://127.0.0.1:9"] });
    const id = (await call("GET", "/api/personas")).json.personas[0].personaId;
    const res = await call("POST", `/api/personas/${id}/publish/solid`, { resourceUrl: `${base}/sandbox/solid/${id}/creativeid.ttl` });
    assert.equal(res.status, 200);
    assert.equal(res.json.indexes[0].ok, true);
    assert.equal(res.json.indexes[1].ok, false);
    assert.ok(res.json.indexes[1].error);
  });
});
