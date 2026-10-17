import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ATPROTO_COLLECTION_NSID,
  createCanonicalPersona,
  PersonaStore,
  toAtprotoRecord,
  toPublicJsonLd,
  toSolidTurtle,
  updateCanonicalPersona,
  validatePersonaInput,
} from "../src/index.js";

describe("Milestone 1: Canonical Schema, Transformers, and Local Storage", () => {
  it("validates required fields and grapheme limits", () => {
    const emptyCheck = validatePersonaInput({ name: "  ", biography: "" });
    assert.equal(emptyCheck.valid, false);
    assert.equal(emptyCheck.issues.length, 2);

    const overNameCheck = validatePersonaInput({
      name: "A".repeat(65),
      biography: "Valid bio",
    });
    assert.equal(overNameCheck.valid, false);
    assert.equal(overNameCheck.issues[0].field, "name");

    const validCheck = validatePersonaInput({
      name: "Ada Lovelace",
      biography: "Analytical Engine pioneer exploring poetical science.",
    });
    assert.equal(validCheck.valid, true);
    assert.equal(validCheck.issues.length, 0);
  });

  it("creates and updates a canonical JSON-LD persona", () => {
    const t0 = new Date("2026-10-17T15:00:00.000Z");
    const persona = createCanonicalPersona(
      {
        name: "  Ada Lovelace ",
        biography: " Analytical Engine pioneer exploring poetical science. ",
      },
      t0
    );

    assert.equal(persona["@id"], "#me");
    assert.deepEqual(persona["@type"], ["Person", "cp:CreativePersona"]);
    assert.equal(persona.name, "Ada Lovelace");
    assert.equal(
      persona.description,
      "Analytical Engine pioneer exploring poetical science."
    );
    assert.equal(persona.dateCreated, "2026-10-17T15:00:00.000Z");
    assert.equal(persona.dateModified, "2026-10-17T15:00:00.000Z");

    const t1 = new Date("2026-10-17T15:10:00.000Z");
    const updated = updateCanonicalPersona(
      persona,
      {
        name: "Ada King, Countess of Lovelace",
        biography: "Mathematician and writer on Charles Babbage's Analytical Engine.",
      },
      t1
    );

    assert.equal(updated.name, "Ada King, Countess of Lovelace");
    assert.equal(updated.dateCreated, "2026-10-17T15:00:00.000Z");
    assert.equal(updated.dateModified, "2026-10-17T15:10:00.000Z");
  });

  it("transforms canonical persona to Public JSON-LD, ATProto Lexicon record, and Solid Turtle", () => {
    const t0 = new Date("2026-10-17T15:00:00.000Z");
    const persona = createCanonicalPersona(
      {
        name: "Ada Lovelace",
        biography: 'Explorer of "poetical science" & algorithms.',
      },
      t0
    );
    persona["cp:publications"] = {
      atproto: {
        uri: "at://did:plc:123/org.creativepassport.actor.persona/self",
        cid: "bafyre123",
        publishedAt: "2026-10-17T15:05:00.000Z",
      },
    };

    // 1. Public JSON-LD (strips local cp:publications)
    const publicJsonLd = toPublicJsonLd(
      persona,
      "https://ada.example/passport.jsonld#me"
    );
    assert.equal(publicJsonLd["@id"], "https://ada.example/passport.jsonld#me");
    assert.equal(publicJsonLd["foaf:name"], "Ada Lovelace");
    assert.equal("cp:publications" in publicJsonLd, false);

    // 2. AT Protocol Lexicon record
    const atprotoRecord = toAtprotoRecord(persona);
    assert.deepEqual(atprotoRecord, {
      $type: ATPROTO_COLLECTION_NSID,
      name: "Ada Lovelace",
      biography: 'Explorer of "poetical science" & algorithms.',
      updatedAt: "2026-10-17T15:00:00.000Z",
    });

    // 3. Solid RDF Turtle
    const turtle = toSolidTurtle(persona, "https://ada.solidcommunity.net/profile/card#me");
    assert.match(turtle, /<https:\/\/ada\.solidcommunity\.net\/profile\/card#me>/);
    assert.match(turtle, /schema:name "Ada Lovelace"/);
    assert.match(
      turtle,
      /schema:description "Explorer of \\"poetical science\\" & algorithms\."/
    );
  });

  it("persists and updates persona and publication status via PersonaStore", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "creative-passport-test-"));
    try {
      const filePath = join(tmpDir, "data", "persona.jsonld");
      const store = new PersonaStore(filePath);

      assert.equal(await store.load(), null);

      const created = await store.upsert(
        {
          name: "Brian Eno",
          biography: "Ambient music pioneer and visual artist.",
        },
        new Date("2026-10-17T15:00:00.000Z")
      );
      assert.equal(created.name, "Brian Eno");

      const withPub = await store.recordPublication("atproto", {
        uri: "at://did:plc:eno/org.creativepassport.actor.persona/self",
        cid: "bafyreibrianeno",
        publishedAt: "2026-10-17T15:02:00.000Z",
      });

      assert.equal(
        withPub["cp:publications"]?.atproto?.uri,
        "at://did:plc:eno/org.creativepassport.actor.persona/self"
      );

      const reloaded = await store.load();
      assert.deepEqual(reloaded, withPub);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
