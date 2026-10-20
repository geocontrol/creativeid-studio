import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { Server } from "node:http";

import {
  createStudioServer,
  fetchFromSolid,
  PersonaLibrary,
  resolveTarget,
  ResolveError,
} from "../src/index.js";

/** A fake network: handle well-known, the public API, plc.directory, did:web and a PDS. */
const fakeNetwork: typeof fetch = async (input, init) => {
  const url = String(input);
  if (url.startsWith("http://127.0.0.1")) return fetch(input, init); // the studio's own sandboxes
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  if (url === "https://venue.example/.well-known/atproto-did") return new Response("did:plc:venue123");
  if (url.endsWith("/.well-known/atproto-did")) return new Response("not found", { status: 404 });
  if (url.startsWith("https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=artist.bsky.social")) {
    return json({ did: "did:plc:artist456" });
  }
  if (url.startsWith("https://public.api.bsky.app/")) return json({ error: "InvalidRequest" }, 400);
  if (url === "https://plc.directory/did:plc:venue123") {
    return json({
      alsoKnownAs: ["at://venue.example"],
      service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://pds.example" }],
    });
  }
  if (url === "https://plc.directory/did:plc:artist456") {
    return json({ alsoKnownAs: ["at://artist.bsky.social"], service: [] });
  }
  if (url === "https://gallery.example/.well-known/did.json") {
    return json({ service: [{ id: "did:web:gallery.example#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://pds.example/" }] });
  }
  if (url.startsWith("https://pds.example/xrpc/com.atproto.repo.getRecord?")) {
    const p = new URL(url).searchParams;
    if (p.get("rkey") === "missing") return json({ error: "RecordNotFound" }, 400);
    return json({ uri: `at://${p.get("repo")}/${p.get("collection")}/${p.get("rkey")}`, cid: "bafyreirealcid123", value: {} });
  }
  return json({ error: "unexpected", url }, 500);
};

describe("M5 · looking up connection targets", () => {
  const opts = { fetchImpl: fakeNetwork };

  it("handle → DID via the handle's own domain, with its PDS", async () => {
    assert.deepEqual(await resolveTarget("@venue.example", opts), {
      kind: "party",
      did: "did:plc:venue123",
      handle: "venue.example",
      pds: "https://pds.example",
    });
  });

  it("handle → DID via the public API when the domain has no well-known file", async () => {
    const r = await resolveTarget("artist.bsky.social", opts);
    assert.equal(r.kind, "party");
    assert.equal(r.did, "did:plc:artist456");
    assert.equal(r.kind === "party" && r.handle, "artist.bsky.social");
  });

  it("at:// link → the record's current CID, resolving a handle in the link", async () => {
    const r = await resolveTarget("at://venue.example/com.cultureblocs.creative.work/3l4k2jxyz2222", opts);
    assert.deepEqual(r, {
      kind: "record",
      uri: "at://did:plc:venue123/com.cultureblocs.creative.work/3l4k2jxyz2222",
      cid: "bafyreirealcid123",
      did: "did:plc:venue123",
      collection: "com.cultureblocs.creative.work",
      rkey: "3l4k2jxyz2222",
      handle: "venue.example",
    });
  });

  it("works for did:web accounts", async () => {
    const r = await resolveTarget("at://did:web:gallery.example/com.cultureblocs.creative.work/abc", opts);
    assert.equal(r.kind === "record" && r.cid, "bafyreirealcid123");
  });

  it("explains what went wrong", async () => {
    await assert.rejects(resolveTarget("not a handle", opts), (e: Error) => e instanceof ResolveError && /isn't|is not/.test(e.message));
    await assert.rejects(resolveTarget("nobody.example", opts), /Couldn't find an account/);
    await assert.rejects(
      resolveTarget("at://did:plc:venue123/com.cultureblocs.creative.work/missing", opts),
      /doesn't exist/
    );
    await assert.rejects(resolveTarget("did:key:z6Mk", opts), /only did:plc and did:web/);
  });
});

describe("M5 · studio server", () => {
  let dir: string;
  let server: Server;
  let base: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "creativeid-m5-"));
    server = createStudioServer({
      library: new PersonaLibrary(join(dir, "personas")),
      exportDir: join(dir, "exports"),
      legacyV1Path: join(dir, "none.jsonld"),
      fetchImpl: fakeNetwork,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    await rm(dir, { recursive: true, force: true });
  });

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  };

  it("serves a page whose every scripted element exists", async () => {
    const html = await (await fetch(`${base}/`)).text();
    const js = await (await fetch(`${base}/app.js`)).text();
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const used = new Set([...js.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]));
    const missing = [...used].filter((id) => !ids.has(id));
    assert.deepEqual(missing, [], "app.js refers to ids the page doesn't have");
    assert.match(html, /<title>CreativeID Studio<\/title>/);
    assert.equal(/creative passport|verified|complete your profile/i.test(html + js), false, "retired wording");
  });

  it("retires the single-persona routes", async () => {
    for (const [method, path] of [["GET", "/api/persona"], ["PUT", "/api/persona"], ["GET", "/api/export/download"], ["POST", "/api/publish/static"]]) {
      assert.equal((await call(method, path, method === "GET" ? undefined : {})).status, 404, `${method} ${path}`);
    }
  });

  it("looks up targets through /api/resolve", async () => {
    const ok = await call("GET", `/api/resolve?q=${encodeURIComponent("venue.example")}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.did, "did:plc:venue123");
    const missing = await call("GET", `/api/resolve?q=${encodeURIComponent("nobody.example")}`);
    assert.equal(missing.status, 404);
    assert.match(missing.json.error, /Couldn't find an account/);
    assert.equal((await call("GET", "/api/resolve")).status, 400);
  });

  it("publishes a persona to Solid and to a saved file through the API", async () => {
    const id = (await call("POST", "/api/personas", { name: "Mira Sato", disciplines: ["choreography"] })).json.persona.personaId;
    await call("POST", `/api/personas/${id}/works`, { title: "Ground Truth", completionDate: "2025" });

    const target = `${base}/sandbox/solid/${id}/creativeid.ttl`;
    const solid = await call("POST", `/api/personas/${id}/publish/solid`, { resourceUrl: target, format: "turtle" });
    assert.equal(solid.status, 200);
    assert.equal(solid.json.persona.publications.solid.uri, `${target}#me`);
    assert.match((await fetchFromSolid(target)).content, /schema:name "Ground Truth"/);

    const saved = await call("POST", `/api/personas/${id}/publish/static`, {
      format: "jsonld",
      publicUrl: "https://mira.example/.well-known/creativeid.jsonld",
    });
    assert.equal(saved.status, 200);
    const file = JSON.parse(await readFile(saved.json.result.outputPath, "utf8"));
    assert.equal(file["@graph"][1].name, "Ground Truth");
  });
});
