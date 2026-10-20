/**
 * Writes the aggregator's test fixtures from this studio's own code, so the
 * aggregator always parses exactly what the studio publishes.
 *
 *   npx tsx scripts/aggregator-fixtures.ts [path to creativeid-aggregator/test/fixtures]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { addConnection, addWork, createPersonaDocument, setPrivateField, toAtprotoRecords, toPublicJsonLd, toTurtle } from "../src/index.js";
const out = process.argv[2] ?? "../creativeid-aggregator/test/fixtures";
mkdirSync(out, { recursive: true });
const T = new Date("2026-10-20T09:00:00.000Z");
let doc = createPersonaDocument({
  name: "Ama \"Lighthouse\" Owusu",
  bio: "Lighting designer and performer.\nWorks across theatre, dance & installation — 光.",
  disciplines: ["lighting design", "performance"],
  based: { name: "Peckham, London" },
  links: [{ uri: "https://ama.example", title: "Portfolio" }],
  externalIds: [{ scheme: "isni", id: "0000 0004 1234 5678" }],
}, { now: T, personaId: "ama-owusu-2222" });
doc = setPrivateField(doc, "legalName", "SECRET-SHOULD-NEVER-APPEAR");
doc = addWork(doc, { title: "Tidal", referenceUrl: "https://ama.example/tidal", completionDate: "Spring 2025", credits: [{ name: "Ama Owusu", role: "lighting design" }, { name: "Kofi", did: "did:plc:kofi123", role: "sound" }], tags: ["light", "water"] }, { now: T, id: "3lwkfixtidal2" }).document;
doc = addWork(doc, { title: "Night Shift", completionDate: "2024" }, { now: T, id: "3lwkfixnight2" }).document;
doc = addConnection(doc, { subject: { did: "did:plc:venue456", name: "Larkfield Rooms" }, relationship: "performed", role: "lighting" }, { now: T, id: "3lwkfixconnaa" }).document;
doc = addConnection(doc, { subject: { uri: "at://did:plc:gallery/com.cultureblocs.creative.work/3l4k2jxyz2222", cid: "bafyreiexamplecid" }, relationship: "exhibited", note: "Group show" }, { now: T, id: "3lwkfixconnbb" }).document;
const base = "https://ama.example/.well-known/creativeid.jsonld";
writeFileSync(`${out}/studio-persona.jsonld`, JSON.stringify(toPublicJsonLd(doc, base), null, 2) + "\n");
writeFileSync(`${out}/studio-persona-relative.jsonld`, JSON.stringify(toPublicJsonLd(doc), null, 2) + "\n");
writeFileSync(`${out}/studio-persona.ttl`, toTurtle(doc, "https://ama.solid.example/public/creativeid.ttl"));
writeFileSync(`${out}/studio-records.json`, JSON.stringify(toAtprotoRecords(doc).map(({ collection, rkey, record }) => ({ collection, rkey, record })), null, 2) + "\n");
console.log(`fixtures written to ${out}`);
