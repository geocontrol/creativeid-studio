import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { Server } from "node:http";
import jsonld from "jsonld";
import { Parser as TurtleParser, Writer as NQuadsWriter } from "n3";

import {
  AccountMismatchError,
  addConnection,
  addWork,
  applyAtprotoResult,
  assertValidRecord,
  cleanupLegacyRecord,
  createPersonaDocument,
  createStudioServer,
  fetchFromSolid,
  fetchRecord,
  LEGACY_NSID,
  NSID,
  PersonaDocument,
  PersonaLibrary,
  planPublish,
  publishPersona,
  PublishFailedError,
  publishStaticExport,
  publishToSolid,
  RecordValidationError,
  removeWork,
  setPrivateField,
  toAtprotoRecords,
  toPublicJsonLd,
  toTurtle,
  updateWork,
} from "../src/index.js";

const T0 = new Date("2026-10-20T09:00:00Z");
const T1 = new Date("2026-10-20T10:00:00Z");
const T2 = new Date("2026-10-20T11:00:00Z");
const SECRET = "SECRET-LEGAL-NAME-4417";

/** A persona that exercises every field and both kinds of connection subject. */
function richPersona(): { doc: PersonaDocument; workIds: string[]; connIds: string[] } {
  let doc = createPersonaDocument(
    {
      name: "Ama \"Lighthouse\" Owusu",
      bio: "Lighting designer and performer.\nWorks across theatre, dance & installation — 光.",
      disciplines: ["lighting design", "performance"],
      based: { name: "Peckham, London" },
      links: [{ uri: "https://ama.example", title: "Portfolio" }],
      externalIds: [{ scheme: "isni", id: "0000 0004 1234 5678", uri: "https://isni.org/isni/0000000412345678" }],
    },
    { now: T0, personaId: "ama-owusu-2222" }
  );
  doc = setPrivateField(doc, "legalName", SECRET);
  const w1 = addWork(doc, {
    title: "Tidal (installation)",
    referenceUrl: "https://ama.example/tidal",
    completionDate: "Spring 2025",
    credits: [{ name: "Ama Owusu", role: "lighting design" }, { name: "Kofi", did: "did:plc:kofi123", role: "sound" }],
    tags: ["light", "water"],
    externalIds: [{ scheme: "wikidata", id: "Q1" }],
  }, { now: T0 });
  doc = w1.document;
  const w2 = addWork(doc, { title: "Night Shift", completionDate: "2024" }, { now: T0 });
  doc = w2.document;
  const c1 = addConnection(doc, { subject: { did: "did:plc:venue456", name: "The Ivy House" }, relationship: "performed", role: "lighting" }, { now: T0 });
  doc = c1.document;
  const c2 = addConnection(doc, {
    subject: { uri: "at://did:plc:gallery/com.cultureblocs.creative.work/3l4k2jxyz2222", cid: "bafyreiexamplecid" },
    relationship: "exhibited",
    note: "Group show",
  }, { now: T0 });
  doc = c2.document;
  return { doc, workIds: [w1.id, w2.id], connIds: [c1.id, c2.id] };
}

describe("M4 · ATProto records", () => {
  it("builds one valid record per profile, work and connection", () => {
    const { doc, workIds, connIds } = richPersona();
    const records = toAtprotoRecords(doc);
    assert.deepEqual(
      records.map((r) => [r.collection, r.rkey]),
      [
        [NSID.profile, "self"],
        [NSID.work, workIds[0]],
        [NSID.work, workIds[1]],
        [NSID.connection, connIds[0]],
        [NSID.connection, connIds[1]],
      ]
    );
    const [profile, work, , party, record] = records.map((r) => r.record);
    assert.equal(profile.$type, NSID.profile);
    assert.equal(profile.bio, "Lighting designer and performer.\nWorks across theatre, dance & installation — 光.");
    assert.deepEqual(profile.based, { name: "Peckham, London" });
    assert.equal(profile.createdAt, T0.toISOString(), "createdAt is the local creation date");
    assert.deepEqual(work.credits, [
      { name: "Ama Owusu", role: "lighting design" },
      { name: "Kofi", did: "did:plc:kofi123", role: "sound" },
    ]);
    assert.deepEqual(party.subject, { $type: NSID.didRef, did: "did:plc:venue456", name: "The Ivy House" });
    assert.deepEqual(record.subject, {
      $type: NSID.strongRef,
      uri: "at://did:plc:gallery/com.cultureblocs.creative.work/3l4k2jxyz2222",
      cid: "bafyreiexamplecid",
    });
  });

  it("never includes private fields or local state", () => {
    const text = JSON.stringify(toAtprotoRecords(richPersona().doc));
    for (const s of [SECRET, "ama-owusu-2222", "creativeid:"]) assert.equal(text.includes(s), false, s);
  });

  it("checks records against the vendored lexicons", () => {
    assert.throws(
      () =>
        assertValidRecord({
          localId: "x",
          collection: NSID.work,
          rkey: "x",
          record: { $type: NSID.work, title: "T", referenceUrl: "not a uri", createdAt: T0.toISOString() },
          dateModified: T0.toISOString(),
        }),
      RecordValidationError
    );
  });
});

describe("M4 · publish plan", () => {
  it("knows what is new, changed, unchanged and deleted", () => {
    const { doc, workIds } = richPersona();
    assert.equal(planPublish(doc).create.length, 5);

    // Pretend everything was published at T1.
    const published: PersonaDocument = structuredClone(doc);
    published["creativeid:publications"].atproto = {
      did: "did:plc:ama",
      records: Object.fromEntries(
        toAtprotoRecords(doc).map((r) => [
          r.localId,
          { uri: `at://did:plc:ama/${r.collection}/${r.rkey}`, cid: "c", rkey: r.rkey, publishedAt: T1.toISOString() },
        ])
      ),
    };
    let plan = planPublish(published);
    assert.equal(plan.unchanged.length, 5);

    let next = updateWork(published, workIds[0], { title: "Tidal" }, T2);
    next = removeWork(next, workIds[1]);
    plan = planPublish(next);
    assert.deepEqual(plan.update.map((r) => r.localId), [workIds[0]]);
    assert.deepEqual(plan.delete.map((d) => [d.collection, d.rkey]), [[NSID.work, workIds[1]]]);
  });

  it("treats a profile last published to the v1 collection as new", () => {
    const { doc } = richPersona();
    doc["creativeid:publications"].atproto = {
      did: "did:plc:ama",
      records: { me: { uri: `at://did:plc:ama/${LEGACY_NSID}/self`, rkey: "self", publishedAt: T2.toISOString() } },
    };
    const plan = planPublish(doc);
    assert.ok(plan.create.some((r) => r.localId === "me"));
    assert.equal(plan.delete.length, 0, "the v1 record is removed by publishPersona, not as a local deletion");
  });
});

describe("M4 · Linked Data outputs", () => {
  const BASE = "https://ama.example/.well-known/creativeid.jsonld";

  async function canonicalFromJsonLd(doc: PersonaDocument): Promise<string> {
    return jsonld.canonize(toPublicJsonLd(doc, BASE), { algorithm: "RDFC-1.0", format: "application/n-quads" });
  }

  async function canonicalFromTurtle(doc: PersonaDocument): Promise<string> {
    const quads = new TurtleParser({ format: "text/turtle" }).parse(toTurtle(doc, BASE));
    const nquads = new NQuadsWriter({ format: "N-Quads" }).quadsToString(quads);
    return jsonld.canonize(nquads, {
      algorithm: "RDFC-1.0",
      inputFormat: "application/n-quads",
      format: "application/n-quads",
    });
  }

  it("JSON-LD and Turtle describe exactly the same triples", async () => {
    const { doc } = richPersona();
    const [a, b] = [await canonicalFromJsonLd(doc), await canonicalFromTurtle(doc)];
    assert.equal(a, b);
    const lines = a.trim().split("\n");
    assert.ok(lines.length > 40, `expected a full graph, got ${lines.length} triples`);
    assert.ok(a.includes(`<${BASE}#me> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://schema.org/Person>`));
    assert.ok(a.includes(`"2026-10-20T09:00:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>`), "typed dates");
    assert.ok(a.includes(`<https://schema.org/url> <https://ama.example/tidal>`), "links are IRIs");
  });

  it("keeps ids relative when no public URL is known", () => {
    const { doc } = richPersona();
    const ttl = toTurtle(doc);
    assert.equal(ttl.includes("@base"), false);
    assert.ok(ttl.startsWith("@prefix schema:"));
    assert.ok(ttl.includes("<#me>\n"));
    assert.equal("@base" in toPublicJsonLd(doc)["@context"], false);
  });

  it("never includes private fields or local state", () => {
    const { doc } = richPersona();
    for (const text of [toTurtle(doc, BASE), JSON.stringify(toPublicJsonLd(doc, BASE))]) {
      for (const s of [SECRET, "ama-owusu-2222", "publications", "schemaVersion"]) {
        assert.equal(text.includes(s), false, s);
      }
    }
  });
});

describe("M4 · publishing", () => {
  let dir: string;
  let server: Server;
  let base: string;
  let pds: string;
  let library: PersonaLibrary;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "creativeid-m4-"));
    library = new PersonaLibrary(join(dir, "personas"));
    server = createStudioServer({ library, exportDir: join(dir, "exports"), legacyV1Path: join(dir, "none.jsonld") });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    pds = `${base}/sandbox/atproto`;
  });

  after(async () => {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    await rm(dir, { recursive: true, force: true });
  });

  const creds = (handle: string) => ({ pdsUrl: pds, identifier: handle, password: "app-password" });
  const didFor = (handle: string) => `did:plc:sandbox${handle.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}`;

  it("publishes every record, then updates and deletes in place", async () => {
    let { doc, workIds } = richPersona();
    const first = await publishPersona(doc, { ...creds("ama.test"), now: T1 });
    assert.equal(first.did, didFor("ama.test"));
    assert.equal(first.created.length, 5);
    doc = { ...doc, "creativeid:publications": applyAtprotoResult(doc["creativeid:publications"], first) };

    const work = await fetchRecord(pds, first.did, NSID.work, workIds[0]);
    assert.equal(work?.value.title, "Tidal (installation)");
    const profile = await fetchRecord(pds, first.did, NSID.profile, "self");
    assert.equal(profile?.value.name, 'Ama "Lighthouse" Owusu');

    const again = await publishPersona(doc, { ...creds("ama.test"), now: T2 });
    assert.deepEqual([again.created, again.updated, again.deleted], [[], [], []], "nothing to do");
    assert.equal(again.unchanged.length, 5);

    doc = updateWork(doc, workIds[0], { title: "Tidal" }, new Date(T2.getTime() + 1000));
    doc = removeWork(doc, workIds[1]);
    const third = await publishPersona(doc, { ...creds("ama.test"), now: new Date(T2.getTime() + 2000) });
    assert.deepEqual(third.updated, [workIds[0]]);
    assert.deepEqual(third.deleted, [`at://${first.did}/${NSID.work}/${workIds[1]}`]);
    assert.equal((await fetchRecord(pds, first.did, NSID.work, workIds[0]))?.value.title, "Tidal");
    assert.equal(await fetchRecord(pds, first.did, NSID.work, workIds[1]), null);
    assert.equal(third.records[workIds[1]], undefined, "removed from local state");
  });

  it("refuses to publish a persona to a different account", async () => {
    const { doc } = richPersona();
    doc["creativeid:publications"].atproto = { did: didFor("ama.test"), records: {} };
    await assert.rejects(publishPersona(doc, creds("someone-else.test")), AccountMismatchError);
  });

  it("removes the v1 Creative Passport record from the same account", async () => {
    const did = didFor("legacy.test");
    const session = await fetch(`${pds}/xrpc/com.atproto.server.createSession`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "legacy.test", password: "x" }),
    }).then((r) => r.json() as Promise<{ accessJwt: string }>);
    await fetch(`${pds}/xrpc/com.atproto.repo.putRecord`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessJwt}` },
      body: JSON.stringify({ repo: did, collection: LEGACY_NSID, rkey: "self", record: { name: "Old" } }),
    });
    const { doc } = richPersona();
    const legacyUri = `at://${did}/${LEGACY_NSID}/self`;
    doc["creativeid:publications"] = { legacyV1: { atproto: { uri: legacyUri, publishedAt: T0.toISOString() } } };

    const result = await publishPersona(doc, creds("legacy.test"));
    assert.ok(result.deleted.includes(legacyUri));
    assert.equal(await fetchRecord(pds, did, LEGACY_NSID, "self"), null);
    const pubs = applyAtprotoResult(doc["creativeid:publications"], result);
    assert.equal(pubs.legacyV1, undefined, "nothing left to clean up");
  });

  it("reports what succeeded when a publish fails part-way", async () => {
    const { doc } = richPersona();
    let puts = 0;
    const flaky: typeof fetch = async (input, init) => {
      if (String(input).endsWith("com.atproto.repo.putRecord") && ++puts === 3) {
        return new Response(JSON.stringify({ error: "InternalServerError" }), { status: 500 });
      }
      return fetch(input, init);
    };
    await assert.rejects(publishPersona(doc, { ...creds("flaky.test"), fetchImpl: flaky }), (err: unknown) => {
      assert.ok(err instanceof PublishFailedError);
      assert.equal(Object.keys(err.partial.records).length, 2, "the two writes that worked are kept");
      return true;
    });
  });

  it("checks lexicons before touching the network", async () => {
    const { doc } = richPersona();
    const broken = structuredClone(doc);
    (broken["@graph"][1] as { url?: string }).url = "not a uri";
    let called = false;
    const spy: typeof fetch = async (input, init) => {
      called = true;
      return fetch(input, init);
    };
    await assert.rejects(publishPersona(broken, { ...creds("strict.test"), fetchImpl: spy }), RecordValidationError);
    assert.equal(called, false);
  });

  it("publishes the whole graph to Solid and to a static file", async () => {
    const { doc } = richPersona();
    const target = `${base}/sandbox/solid/public/creativeid.ttl`;
    const solid = await publishToSolid(doc, { resourceUrl: target });
    assert.equal(solid.status.uri, `${target}#me`);
    const back = await fetchFromSolid(target);
    assert.ok(back.content.startsWith(`@base <${target}> .`));
    assert.match(back.content, /schema:name "Night Shift"/);
    assert.match(back.content, /creativeid:relationship "exhibited"/);

    const out = join(dir, "static", "creativeid.jsonld");
    const stat = await publishStaticExport(doc, { outputPath: out, publicUrl: "https://ama.example/.well-known/creativeid.jsonld" });
    assert.equal(stat.status.uri, "https://ama.example/.well-known/creativeid.jsonld#me");
    const written = JSON.parse(await readFile(out, "utf8"));
    assert.equal(written["@context"]["@base"], "https://ama.example/.well-known/creativeid.jsonld");
    assert.equal(written["@graph"].length, 5);
  });

  it("API: one account per persona, a publish plan, and publications recorded", async () => {
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: (await res.json()) as any };
    };
    const a = (await call("POST", "/api/personas", { name: "Persona A" })).json.persona.personaId;
    const b = (await call("POST", "/api/personas", { name: "Persona B" })).json.persona.personaId;
    await call("POST", `/api/personas/${a}/works`, { title: "A work" });

    const plan = await call("GET", `/api/personas/${a}/publish/atproto/plan`);
    assert.deepEqual(plan.json.create.map((r: any) => r.collection), [NSID.profile, NSID.work]);

    const pubA = await call("POST", `/api/personas/${a}/publish/atproto`, creds("shared.test"));
    assert.equal(pubA.status, 200);
    assert.equal(pubA.json.persona.publications.atproto.did, didFor("shared.test"));
    assert.equal(Object.keys(pubA.json.persona.publications.atproto.records).length, 2);
    assert.equal(JSON.stringify(pubA.json).includes("app-password"), false, "password never echoed or stored");

    const after = await call("GET", `/api/personas/${a}/publish/atproto/plan`);
    assert.equal(after.json.unchanged.length, 2);

    const pubB = await call("POST", `/api/personas/${b}/publish/atproto`, creds("shared.test"));
    assert.equal(pubB.status, 409);
    assert.match(pubB.json.error, /already publishes the persona "Persona A"/);

    const mismatch = await call("POST", `/api/personas/${a}/publish/atproto`, creds("other.test"));
    assert.equal(mismatch.status, 409);

    const preview = await call("GET", `/api/personas/${a}/preview`);
    assert.deepEqual(Object.keys(preview.json.previews).sort(), ["atproto", "jsonld", "turtle"]);
    const stored = await readFile(library.pathFor(a), "utf8");
    assert.equal(stored.includes("app-password"), false);
  });

  it("cleanup tool: dry run reports, --apply deletes", async () => {
    const did = didFor("cleanup.test");
    const token = (await fetch(`${pds}/xrpc/com.atproto.server.createSession`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "cleanup.test", password: "x" }),
    }).then((r) => r.json())) as { accessJwt: string };
    await fetch(`${pds}/xrpc/com.atproto.repo.putRecord`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.accessJwt}` },
      body: JSON.stringify({ repo: did, collection: LEGACY_NSID, rkey: "self", record: { name: "Old" } }),
    });
    const dry = await cleanupLegacyRecord(creds("cleanup.test"));
    assert.deepEqual([dry.found, dry.deleted], [true, false]);
    assert.ok(await fetchRecord(pds, did, LEGACY_NSID, "self"));
    const applied = await cleanupLegacyRecord({ ...creds("cleanup.test"), apply: true });
    assert.deepEqual([applied.found, applied.deleted], [true, true]);
    assert.equal(await fetchRecord(pds, did, LEGACY_NSID, "self"), null);
    const none = await cleanupLegacyRecord(creds("cleanup.test"));
    assert.equal(none.found, false);
  });
});
