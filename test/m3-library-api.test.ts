import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { Server } from "node:http";

import {
  addWork,
  createStudioServer,
  getProfile,
  getWorks,
  isTid,
  PersonaFileDamaged,
  PersonaLibrary,
  PersonaNotFound,
} from "../src/index.js";

const exists = (p: string) => access(p).then(() => true, () => false);

const V1_FILE = {
  "@context": { "@vocab": "https://schema.org/" },
  "@id": "#me",
  "@type": ["Person", "creativeid:Persona"],
  name: "Delia Derbyshire",
  description: "Radiophonic Workshop composer.",
  dateCreated: "2026-10-17T10:00:00.000Z",
  dateModified: "2026-10-17T11:00:00.000Z",
  "creativeid:publications": {
    atproto: { uri: "at://did:plc:delia/org.creativepassport.actor.persona/self", publishedAt: "2026-10-17T11:00:00Z" },
  },
};

describe("M3 · PersonaLibrary", () => {
  let dir: string;
  let lib: PersonaLibrary;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "creativeid-lib-"));
    lib = new PersonaLibrary(join(dir, "personas"));
  });

  it("starts empty, then creates, lists and reads personas", async () => {
    assert.deepEqual(await lib.list(), []);
    const a = await lib.create({ name: "Pauline Oliveros", disciplines: ["deep listening"] });
    const b = await lib.create({ name: "Pauline Oliveros" }); // same name, different id
    assert.notEqual(a["creativeid:personaId"], b["creativeid:personaId"]);
    const list = await lib.list();
    assert.equal(list.length, 2);
    assert.deepEqual(list[0].disciplines, ["deep listening"]);
    assert.deepEqual(await lib.get(a["creativeid:personaId"]), a);
    assert.equal(await lib.get("nobody-2222"), null);
  });

  it("writes one pretty-printed file per persona and no temp files", async () => {
    const doc = await lib.create({ name: "Hildegard Westerkamp" });
    const files = await readdir(lib.root);
    assert.deepEqual(files, [`${doc["creativeid:personaId"]}.jsonld`]);
    const text = await readFile(lib.pathFor(doc["creativeid:personaId"]), "utf8");
    assert.ok(text.includes('\n  "@graph"'), "pretty-printed");
  });

  it("moves deleted personas to .trash instead of deleting them", async () => {
    const doc = await lib.create({ name: "Éliane Radigue" });
    const id = doc["creativeid:personaId"];
    const trashed = await lib.delete(id);
    assert.ok(trashed.startsWith(lib.trashDir));
    assert.ok(await exists(trashed));
    assert.equal(await lib.get(id), null);
    assert.deepEqual(await lib.list(), [], ".trash is not listed");
    await assert.rejects(lib.delete(id), PersonaNotFound);
  });

  it("refuses ids that could escape the folder", async () => {
    for (const bad of ["../secret", "a/b", "..", "", "UPPER", "-lead"]) {
      assert.throws(() => lib.pathFor(bad), PersonaNotFound, bad);
    }
  });

  it("reports a damaged file instead of overwriting it", async () => {
    const doc = await lib.create({ name: "Wendy Carlos" });
    const path = lib.pathFor(doc["creativeid:personaId"]);
    await writeFile(path, "{ not json", "utf8");
    await assert.rejects(lib.get(doc["creativeid:personaId"]), PersonaFileDamaged);
    await assert.rejects(lib.update(doc["creativeid:personaId"], (d) => d), PersonaFileDamaged);
    assert.equal(await readFile(path, "utf8"), "{ not json", "left untouched");
  });

  it("serialises concurrent edits so none are lost", async () => {
    const doc = await lib.create({ name: "Laurie Anderson" });
    const id = doc["creativeid:personaId"];
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => lib.update(id, (d) => addWork(d, { title: `Work ${i}` }).document))
    );
    const works = getWorks((await lib.get(id))!);
    assert.equal(works.length, 25);
    assert.equal(new Set(works.map((w) => w.name)).size, 25);
  });

  it("will not let an update change a persona's id", async () => {
    const doc = await lib.create({ name: "Suzanne Ciani" });
    await assert.rejects(
      lib.update(doc["creativeid:personaId"], (d) => ({ ...d, "creativeid:personaId": "other-2222" })),
      /cannot be changed/
    );
  });
});

describe("M3 · importing the v1 file", () => {
  let dir: string;
  let lib: PersonaLibrary;
  let v1Path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "creativeid-mig-"));
    lib = new PersonaLibrary(join(dir, "personas"));
    v1Path = join(dir, "persona.jsonld");
  });

  it("imports into an empty library and keeps the original as a .bak", async () => {
    await writeFile(v1Path, JSON.stringify(V1_FILE), "utf8");
    const result = await lib.migrateV1(v1Path);
    assert.ok(result);
    assert.equal(result.backupPath, join(dir, "persona.v1.jsonld.bak"));
    assert.equal(await exists(v1Path), false);
    assert.deepEqual(JSON.parse(await readFile(result.backupPath, "utf8")), V1_FILE);

    const doc = (await lib.get(result.personaId))!;
    assert.equal(getProfile(doc).name, "Delia Derbyshire");
    assert.deepEqual(doc["creativeid:publications"].legacyV1, V1_FILE["creativeid:publications"]);
    assert.equal(await lib.migrateV1(v1Path), null, "nothing left to import");
  });

  it("does nothing when there is no v1 file", async () => {
    assert.equal(await lib.migrateV1(v1Path), null);
  });

  it("leaves the v1 file alone if the library already has personas", async () => {
    await lib.create({ name: "Already Here" });
    await writeFile(v1Path, JSON.stringify(V1_FILE), "utf8");
    assert.equal(await lib.migrateV1(v1Path), null);
    assert.ok(await exists(v1Path));
    assert.equal((await lib.list()).length, 1);
  });
});

describe("M3 · persona API (network switched off)", () => {
  let dir: string;
  let server: Server;
  let base: string;
  let lib: PersonaLibrary;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "creativeid-api-"));
    await mkdir(join(dir, "data"), { recursive: true });
    await writeFile(join(dir, "data", "persona.jsonld"), JSON.stringify(V1_FILE), "utf8");
    lib = new PersonaLibrary(join(dir, "data", "personas"));
    const offline = (async () => {
      throw new Error("network is switched off in this test");
    }) as typeof fetch;
    server = createStudioServer({
      library: lib,
      legacyV1Path: join(dir, "data", "persona.jsonld"),
      exportDir: join(dir, "data", "exports"),
      fetchImpl: offline,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    await rm(dir, { recursive: true, force: true });
  });

  async function call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json, headers: res.headers };
  }

  it("imported the v1 persona before serving the first request", async () => {
    const { status, json } = await call("GET", "/api/personas");
    assert.equal(status, 200);
    assert.equal(json.personas.length, 1);
    assert.equal(json.personas[0].name, "Delia Derbyshire");
    assert.ok(await exists(join(dir, "data", "persona.v1.jsonld.bak")));
  });

  it("creates a persona with plain field names and no JSON-LD keys", async () => {
    const { status, json } = await call("POST", "/api/personas", {
      name: "Moor Mother",
      bio: "Poet, musician, activist.",
      disciplines: ["poetry", "noise"],
      based: { name: "Philadelphia" },
      links: [{ uri: "https://moormother.example", title: "Site" }],
    });
    assert.equal(status, 201);
    const p = json.persona;
    assert.match(p.personaId, /^moor-mother-[a-z2-7]{4}$/);
    assert.deepEqual(p.profile.disciplines, ["poetry", "noise"]);
    assert.deepEqual(p.works, []);
    assert.equal(JSON.stringify(p).includes("@graph"), false);
    assert.equal(json.previews.jsonld["@graph"][0].name, "Moor Mother");
  });

  it("runs the whole create → edit → delete cycle for works and connections", async () => {
    const created = await call("POST", "/api/personas", { name: "Curator Test" });
    const id = created.json.persona.personaId;

    const w = await call("POST", `/api/personas/${id}/works`, {
      title: "Sound Off (exhibition)",
      completionDate: "2025",
      credits: [{ name: "Curator Test", role: "curator" }],
    });
    assert.equal(w.status, 201);
    assert.ok(isTid(w.json.id));
    assert.equal(w.json.persona.works[0].credits[0].role, "curator");

    const wu = await call("PUT", `/api/personas/${id}/works/${w.json.id}`, { title: "Sound Off", tags: ["sound art"] });
    assert.equal(wu.status, 200);
    assert.equal(wu.json.persona.works[0].title, "Sound Off");
    assert.equal(wu.json.persona.works[0].completionDate, undefined, "PUT replaces");

    const c = await call("POST", `/api/personas/${id}/connections`, {
      subject: { uri: "at://did:plc:gallery/com.cultureblocs.creative.work/3l4k2jxyz2222" },
      relationship: "curated",
    });
    assert.equal(c.status, 201);
    assert.deepEqual(c.json.warnings.map((x: any) => x.path), ["connection.subject.cid"]);
    assert.equal(c.json.persona.warnings.length, 1, "warning also shown on the persona");

    const cu = await call("PUT", `/api/personas/${id}/connections/${c.json.id}`, {
      subject: { did: "did:plc:gallery" },
      relationship: "exhibited",
    });
    assert.equal(cu.json.persona.connections[0].relationship, "exhibited");
    assert.equal(cu.json.persona.warnings.length, 0);

    assert.equal((await call("DELETE", `/api/personas/${id}/connections/${c.json.id}`)).status, 200);
    const wd = await call("DELETE", `/api/personas/${id}/works/${w.json.id}`);
    assert.deepEqual(wd.json.persona.works, []);
    assert.equal((await call("DELETE", `/api/personas/${id}/works/${w.json.id}`)).status, 404);
  });

  it("returns 400 with field paths for invalid input", async () => {
    const bad = await call("POST", "/api/personas", { name: "", links: [{ uri: "nope" }] });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.json.issues.map((i: any) => i.path).sort(), ["profile.links[0].uri", "profile.name"]);

    const id = (await call("POST", "/api/personas", { name: "Valid" })).json.persona.personaId;
    const w = await call("POST", `/api/personas/${id}/works`, { title: "" });
    assert.equal(w.status, 400);
    assert.deepEqual(w.json.issues.map((i: any) => i.path), ["work.title"]);

    const junk = await fetch(`${base}/api/personas`, { method: "POST", body: "{oops" });
    assert.equal(junk.status, 400);
  });

  it("returns 404 for unknown or unsafe ids", async () => {
    for (const path of ["/api/personas/nobody-2222", "/api/personas/..%2F..%2Fetc", "/api/personas/UPPER"]) {
      assert.equal((await call("GET", path)).status, 404, path);
    }
    assert.equal((await call("GET", "/api/nothing-here")).status, 404);
  });

  it("keeps private fields out of every preview and download", async () => {
    const id = (await call("POST", "/api/personas", { name: "Pseudonym" })).json.persona.personaId;
    const put = await call("PUT", `/api/personas/${id}/private`, { key: "legalName", value: "SECRET-NAME-9931" });
    assert.equal(put.json.persona.private.legalName, "SECRET-NAME-9931", "visible to its owner");

    const preview = await call("GET", `/api/personas/${id}/preview`);
    assert.equal(JSON.stringify(preview.json).includes("SECRET-NAME-9931"), false);
    for (const format of ["jsonld", "turtle"]) {
      const dl = await call("GET", `/api/personas/${id}/export/download?format=${format}`);
      assert.equal(dl.status, 200);
      assert.equal(String(dl.json === null ? "" : JSON.stringify(dl.json)).includes("SECRET-NAME-9931"), false);
    }
  });

  it("publishes a chosen persona to a static file and records it on that persona only", async () => {
    const list = (await call("GET", "/api/personas")).json.personas;
    const [first, second] = [list[0].personaId, list[1].personaId];
    const res = await call("POST", `/api/personas/${second}/publish/static`, {
      publicUrl: "https://moor.example/.well-known/creativeid.jsonld",
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.persona.publications.static.uri, "https://moor.example/.well-known/creativeid.jsonld#me");
    assert.ok(await exists(join(dir, "data", "exports", second, "creativeid.jsonld")), "per-persona export folder");
    const other = await call("GET", `/api/personas/${first}`);
    assert.equal(other.json.persona.publications.static, undefined);
  });

  it("fails publishing cleanly when the network is off, without changing the persona", async () => {
    const id = (await call("GET", "/api/personas")).json.personas[0].personaId;
    const before = (await call("GET", `/api/personas/${id}`)).json.persona;
    const res = await call("POST", `/api/personas/${id}/publish/atproto`, {
      pdsUrl: "https://pds.example",
      identifier: "someone.example",
      password: "x",
    });
    assert.equal(res.status, 500);
    assert.match(res.json.error, /network is switched off/);
    assert.deepEqual((await call("GET", `/api/personas/${id}`)).json.persona, before);
  });

  it("moves a persona to the trash via DELETE", async () => {
    const id = (await call("POST", "/api/personas", { name: "Temporary" })).json.persona.personaId;
    const del = await call("DELETE", `/api/personas/${id}`);
    assert.equal(del.status, 200);
    assert.ok(await exists(del.json.trashedTo));
    assert.equal((await call("GET", `/api/personas/${id}`)).status, 404);
  });
});
