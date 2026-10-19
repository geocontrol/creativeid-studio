import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  addConnection,
  addWork,
  createPersonaDocument,
  createTidGenerator,
  findWork,
  fromV1,
  getConnections,
  getProfile,
  getWorks,
  isPersonaId,
  isTid,
  LEXICON_LIMITS,
  localIdOf,
  makePersonaId,
  PersonaDocument,
  PersonaNotFoundError,
  PersonaValidationError,
  removeConnection,
  removeWork,
  setPrivateField,
  toConnectionInput,
  toProfileInput,
  toPublicDocument,
  toWorkInput,
  updateConnection,
  updateProfile,
  updateWork,
  validateConnectionInput,
  validateDocument,
  validateProfileInput,
  validateWorkInput,
} from "../src/index.js";

const T0 = new Date("2026-10-19T12:00:00Z");
const T1 = new Date("2026-10-20T09:30:00Z");

function errorsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof PersonaValidationError) return err.issues.map((i) => i.path);
    throw err;
  }
  assert.fail("expected a PersonaValidationError");
}

describe("M2 · TIDs", () => {
  it("are 13 base32-sortable characters", () => {
    const gen = createTidGenerator(7);
    const tid = gen.next(T0);
    assert.equal(tid.length, 13);
    assert.ok(isTid(tid), tid);
    assert.equal(isTid("not-a-tid"), false);
    assert.equal(isTid("z222222222222"), false, "first char must keep the top bit clear");
  });

  it("sort in creation order, even when the clock stalls or steps back", () => {
    const gen = createTidGenerator(3);
    const tids = [
      ...Array.from({ length: 500 }, () => gen.next(T0)), // same instant
      gen.next(new Date(T0.getTime() - 60_000)), // clock steps backwards
      gen.next(T1),
    ];
    const sorted = [...tids].sort();
    assert.deepEqual(tids, sorted);
    assert.equal(new Set(tids).size, tids.length, "all unique");
  });

  it("rejects an out-of-range clock id", () => {
    assert.throws(() => createTidGenerator(1024), RangeError);
  });
});

describe("M2 · persona ids", () => {
  it("are a slug of the name plus a random suffix", () => {
    const id = makePersonaId("Daphne Oram & the Oramics Machine");
    assert.match(id, /^daphne-oram-the-oramics-machine-[a-z2-7]{4}$/);
    assert.ok(isPersonaId(id));
  });

  it("handle accents and names with no Latin letters", () => {
    assert.match(makePersonaId("Björk Guðmundsdóttir"), /^bjork-gu-mundsdottir-[a-z2-7]{4}$/);
    assert.match(makePersonaId("草間彌生"), /^persona-[a-z2-7]{4}$/);
  });
});

describe("M2 · lexicon limits", () => {
  it("only the profile name is required", () => {
    const ok = validateProfileInput({ name: "Ada" });
    assert.equal(ok.valid, true);
    assert.deepEqual(ok.warnings, []);
    const empty = validateProfileInput({ name: "" });
    assert.deepEqual(empty.errors.map((e) => e.path), ["profile.name"]);
  });

  it("counts graphemes, not bytes or UTF-16 units", () => {
    const flags = "🏳️‍🌈".repeat(LEXICON_LIMITS.profile.name); // multi-codepoint graphemes
    assert.equal(validateProfileInput({ name: flags }).valid, true);
    assert.equal(validateProfileInput({ name: flags + "x" }).valid, false);
  });

  it("enforces profile limits", () => {
    const L = LEXICON_LIMITS.profile;
    const r = validateProfileInput({
      name: "A".repeat(L.name + 1),
      bio: "b".repeat(L.bio + 1),
      disciplines: Array.from({ length: L.disciplines + 1 }, (_, i) => `d${i}`),
      links: [{ uri: "not a uri" }],
      externalIds: [{ scheme: "orcid", id: "" }],
      based: { did: "did:nope" },
    });
    assert.deepEqual(r.errors.map((e) => e.path).sort(), [
      "profile.based.did",
      "profile.bio",
      "profile.disciplines",
      "profile.externalIds[0].id",
      "profile.links[0].uri",
      "profile.name",
    ]);
  });

  it("allows the bio up to 2,000 characters (v1 capped it at 1,000)", () => {
    assert.equal(validateProfileInput({ name: "A", bio: "b".repeat(2000) }).valid, true);
  });

  it("enforces work limits", () => {
    const L = LEXICON_LIMITS.work;
    const r = validateWorkInput({
      title: "T".repeat(L.title + 1),
      referenceUrl: "instagram.com/p/123",
      completionDate: "c".repeat(L.completionDate + 1),
      credits: [{ name: "", role: "lighting design" }],
      tags: Array.from({ length: L.tags + 1 }, (_, i) => `t${i}`),
    });
    assert.deepEqual(r.errors.map((e) => e.path).sort(), [
      "work.completionDate",
      "work.credits[0].name",
      "work.referenceUrl",
      "work.tags",
      "work.title",
    ]);
  });

  it("treats completion dates as free text", () => {
    for (const d of ["2024", "Spring 2019", "ongoing", "c. 1970s"]) {
      assert.equal(validateWorkInput({ title: "W", completionDate: d }).valid, true, d);
    }
  });

  it("checks connection subjects and warns (only) when a record is not CID-pinned", () => {
    const party = validateConnectionInput({ subject: { did: "did:plc:abc123" }, relationship: "performed" });
    assert.equal(party.valid, true);
    assert.deepEqual(party.warnings, []);

    const unpinned = validateConnectionInput({
      subject: { uri: "at://did:plc:abc123/com.cultureblocs.creative.work/3l4k2j" },
      relationship: "exhibited",
    });
    assert.equal(unpinned.valid, true);
    assert.deepEqual(unpinned.warnings.map((w) => w.path), ["connection.subject.cid"]);

    const bad = validateConnectionInput({ subject: { uri: "" }, relationship: "r".repeat(65) });
    assert.deepEqual(bad.errors.map((e) => e.path).sort(), ["connection.relationship", "connection.subject"]);
  });

  it("accepts any relationship word, not just the known ones", () => {
    const r = validateConnectionInput({ subject: { did: "did:web:example.org" }, relationship: "commissioned" });
    assert.equal(r.valid, true);
  });
});

describe("M2 · documents", () => {
  function sample(): PersonaDocument {
    return createPersonaDocument(
      {
        name: "  Laurie Spiegel ",
        bio: "Composer and software developer.",
        disciplines: ["electronic music", " ", "software"],
        based: { name: "New York" },
        links: [{ uri: "https://laurie.example", title: "Website" }, { uri: "  " }],
        externalIds: [{ scheme: "wikidata", id: "Q448794" }],
      },
      { now: T0, personaId: "laurie-spiegel-ab2c" }
    );
  }

  it("creates a JSON-LD graph with the profile at #me", () => {
    const doc = sample();
    assert.equal(doc["creativeid:schemaVersion"], 2);
    assert.equal(doc["creativeid:personaId"], "laurie-spiegel-ab2c");
    assert.equal(doc["@context"].creativeid, "https://www.cultureblocs.com/ns/creativeid#");
    const p = getProfile(doc);
    assert.deepEqual(p["@type"], ["Person", "creativeid:Persona"]);
    assert.equal(p.name, "Laurie Spiegel", "trimmed");
    assert.deepEqual(p.knowsAbout, ["electronic music", "software"], "empty items dropped");
    assert.deepEqual(p.homeLocation, { "@type": "Place", name: "New York" });
    assert.deepEqual(p["creativeid:links"], [{ "@type": "WebPage", url: "https://laurie.example", name: "Website" }]);
    assert.deepEqual(p.identifier, [{ "@type": "PropertyValue", propertyID: "wikidata", value: "Q448794" }]);
    assert.equal(p.dateCreated, T0.toISOString());
  });

  it("round-trips profile input through the stored node", () => {
    const input = toProfileInput(getProfile(sample()));
    assert.deepEqual(input, {
      name: "Laurie Spiegel",
      bio: "Composer and software developer.",
      disciplines: ["electronic music", "software"],
      based: { name: "New York" },
      links: [{ uri: "https://laurie.example", title: "Website" }],
      externalIds: [{ scheme: "wikidata", id: "Q448794" }],
    });
  });

  it("refuses to create a persona with no name", () => {
    assert.deepEqual(errorsOf(() => createPersonaDocument({ name: "   " })), ["profile.name"]);
  });

  it("adds, updates and removes works without touching the input document", () => {
    const doc = sample();
    const { document: d1, id } = addWork(
      doc,
      {
        title: "The Expanding Universe",
        referenceUrl: "https://laurie.example/expanding-universe",
        completionDate: "1980",
        credits: [{ name: "Laurie Spiegel", role: "composer" }],
        tags: ["GROOVE"],
      },
      { now: T0 }
    );
    assert.ok(isTid(id));
    assert.equal(getWorks(doc).length, 0, "original unchanged");
    const w = findWork(d1, id)!;
    assert.equal(w["@id"], `#work-${id}`);
    assert.equal(localIdOf(w), id);
    assert.deepEqual(w["@type"], ["CreativeWork", "creativeid:Work"]);

    const d2 = updateWork(d1, id, { ...toWorkInput(w), title: "The Expanding Universe (1980)", tags: [] }, T1);
    const w2 = findWork(d2, id)!;
    assert.equal(w2.name, "The Expanding Universe (1980)");
    assert.equal(w2.keywords, undefined, "cleared field removed");
    assert.equal(w2.dateCreated, T0.toISOString(), "created date kept");
    assert.equal(w2.dateModified, T1.toISOString());

    const d3 = removeWork(d2, id);
    assert.equal(getWorks(d3).length, 0);
    assert.throws(() => removeWork(d3, id), PersonaNotFoundError);
    assert.throws(() => updateWork(d3, id, { title: "x" }), PersonaNotFoundError);
  });

  it("keeps the graph in order: profile, works, connections", () => {
    let doc = sample();
    const c = addConnection(doc, { subject: { did: "did:plc:bellelabs" }, relationship: "collaborated_on" }, { now: T0 });
    doc = c.document;
    doc = addWork(doc, { title: "Appalachian Grove" }, { now: T1 }).document;
    const kinds = doc["@graph"].map((n) => n["@id"].split("-")[0]);
    assert.deepEqual(kinds, ["#me", "#work", "#claim"]);
  });

  it("adds, updates and removes connections, returning warnings", () => {
    const doc = sample();
    const uri = "at://did:plc:venue/com.cultureblocs.creative.work/3l4k2jxyz2222";
    const added = addConnection(doc, { subject: { uri }, relationship: "exhibited", role: "artist" }, { now: T0 });
    assert.deepEqual(added.warnings.map((w) => w.path), ["connection.subject.cid"]);
    const node = getConnections(added.document)[0];
    assert.equal(node["@type"], "creativeid:Connection");
    assert.deepEqual(node["creativeid:subject"], { "creativeid:uri": uri });

    const pinned = updateConnection(
      added.document,
      added.id,
      { ...toConnectionInput(node), subject: { uri, cid: "bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5uxgf5zy4p3yd2gq5gq4" } },
      T1
    );
    assert.equal(
      (getConnections(pinned)[0]["creativeid:subject"] as Record<string, string>)["creativeid:cid"].slice(0, 6),
      "bafyre"
    );
    assert.equal(getConnections(removeConnection(pinned, added.id)).length, 0);
  });

  it("rejects a duplicate or malformed supplied id", () => {
    const doc = sample();
    const { document, id } = addWork(doc, { title: "One" }, { now: T0 });
    assert.deepEqual(errorsOf(() => addWork(document, { title: "Two" }, { id })), ["work.id"]);
    assert.deepEqual(errorsOf(() => addWork(document, { title: "Two" }, { id: "abc" })), ["work.id"]);
  });

  it("updateProfile replaces fields and keeps the created date", () => {
    const doc = updateProfile(sample(), { name: "Laurie Spiegel", disciplines: ["algorithmic composition"] }, T1);
    const p = getProfile(doc);
    assert.equal(p.description, undefined, "bio cleared");
    assert.deepEqual(p.knowsAbout, ["algorithmic composition"]);
    assert.equal(p.dateCreated, T0.toISOString());
    assert.equal(p.dateModified, T1.toISOString());
  });
});

describe("M2 · nothing local leaves the machine", () => {
  it("toPublicDocument drops private fields, publication state and the local id", () => {
    let doc = createPersonaDocument({ name: "Pseudonymous Artist" }, { now: T0, personaId: "pseudo-2222" });
    doc = setPrivateField(doc, "legalName", "SECRET-LEGAL-NAME-7731");
    doc = setPrivateField(doc, "bookingEmail", "secret-booking@example.org");
    doc["creativeid:publications"] = {
      atproto: { did: "did:plc:secretdid", records: { me: { uri: "at://x", rkey: "self", publishedAt: T0.toISOString() } } },
    };
    doc = addWork(doc, { title: "Public work" }, { now: T0 }).document;

    const pub = toPublicDocument(doc);
    assert.deepEqual(Object.keys(pub).sort(), ["@context", "@graph"]);
    const text = JSON.stringify(pub);
    for (const secret of ["SECRET-LEGAL-NAME-7731", "secret-booking@example.org", "did:plc:secretdid", "pseudo-2222", "legalName"]) {
      assert.equal(text.includes(secret), false, `leaked ${secret}`);
    }
    assert.ok(text.includes("Public work"));
  });

  it("setPrivateField removes a field when the value is empty", () => {
    let doc = createPersonaDocument({ name: "A" }, { now: T0 });
    doc = setPrivateField(doc, "legalName", "X");
    doc = setPrivateField(doc, "legalName", "  ");
    assert.deepEqual(doc["creativeid:private"], {});
  });
});

describe("M2 · validating stored files", () => {
  it("accepts documents produced by the model", () => {
    let doc = createPersonaDocument({ name: "A" }, { now: T0 });
    doc = addWork(doc, { title: "W" }, { now: T0 }).document;
    doc = addConnection(doc, { subject: { did: "did:plc:x1" }, relationship: "member_of" }, { now: T0 }).document;
    const r = validateDocument(doc);
    assert.deepEqual(r.errors, []);
  });

  it("catches hand-edited damage", () => {
    let doc = createPersonaDocument({ name: "A" }, { now: T0 });
    doc = addWork(doc, { title: "W" }, { now: T0 }).document;
    const broken = structuredClone(doc);
    broken["@graph"].push(structuredClone(broken["@graph"][1])); // duplicate work
    (broken["@graph"][1] as { name: string }).name = "x".repeat(301);
    const paths = validateDocument(broken).errors.map((e) => e.path);
    assert.ok(paths.includes("@graph[2]"), "duplicate id");
    assert.ok(paths.includes("works[0].title"), "over-long title");
  });
});

describe("M2 · importing a v1 Creative Passport file", () => {
  it("keeps the name, bio and dates, and parks old publication state for cleanup", () => {
    const v1 = {
      "@context": {},
      "@id": "#me",
      "@type": ["Person", "cp:CreativePersona"],
      name: "Ada Lovelace",
      description: "Poetical science.",
      dateCreated: "2026-10-17T15:20:00.000Z",
      dateModified: "2026-10-17T15:21:00.000Z",
      "cp:publications": {
        atproto: { uri: "at://did:plc:ada/org.creativepassport.actor.persona/self", publishedAt: "2026-10-17T15:21:00Z" },
      },
    };
    const doc = fromV1(v1, { now: T1 });
    const p = getProfile(doc);
    assert.equal(p.name, "Ada Lovelace");
    assert.equal(p.description, "Poetical science.");
    assert.equal(p.dateCreated, "2026-10-17T15:20:00.000Z");
    assert.match(doc["creativeid:personaId"], /^ada-lovelace-[a-z2-7]{4}$/);
    assert.deepEqual(doc["creativeid:publications"], { legacyV1: v1["cp:publications"] });
    assert.equal(validateDocument(doc).valid, true);
    assert.equal(JSON.stringify(toPublicDocument(doc)).includes("creativepassport"), false);
  });
});
