/**
 * Public Linked Data outputs (`src/rdf.ts`) — M4.
 *
 * The whole persona graph (profile, works, connections) as JSON-LD or Turtle,
 * built from toPublicDocument() only. Both describe exactly the same triples
 * (the tests check this with a real JSON-LD processor and Turtle parser).
 *
 * Node ids stay relative (#me, #work-<tid>, #claim-<tid>) so a file resolves
 * against wherever it is hosted. When the public URL is known it is written
 * as the base (@base in both formats), so a downloaded copy still resolves.
 */

import { CREATIVEID_NS, GraphNode, PersonaDocument, toPublicDocument } from "./model/index.js";

const SCHEMA = "https://schema.org/";
const XSD = "http://www.w3.org/2001/XMLSchema#";

/** Keys whose values are IRIs, not text. */
const IRI_KEYS = new Set(["url", "creativeid:did", "creativeid:uri"]);
/** Keys whose values are xsd:dateTime. */
const DATE_KEYS = new Set(["dateCreated", "dateModified"]);

/** The context used for published JSON-LD: the stored one plus value types. */
export const PUBLIC_CONTEXT = {
  "@vocab": SCHEMA,
  creativeid: CREATIVEID_NS,
  xsd: XSD,
  url: { "@type": "@id" },
  "creativeid:did": { "@type": "@id" },
  "creativeid:uri": { "@type": "@id" },
  dateCreated: { "@type": "xsd:dateTime" },
  dateModified: { "@type": "xsd:dateTime" },
} as const;

/** The document URL without its fragment, or undefined. */
export function baseOf(url?: string): string | undefined {
  const t = url?.trim();
  return t ? t.split("#")[0] : undefined;
}

export interface PublicJsonLd {
  "@context": Record<string, unknown>;
  "@graph": GraphNode[];
}

export function toPublicJsonLd(doc: PersonaDocument, publicUrl?: string): PublicJsonLd {
  const base = baseOf(publicUrl);
  return {
    "@context": base ? { "@base": base, ...PUBLIC_CONTEXT } : { ...PUBLIC_CONTEXT },
    "@graph": toPublicDocument(doc)["@graph"],
  };
}

// ---------------------------------------------------------------------------
// Turtle
// ---------------------------------------------------------------------------

function escapeLiteral(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/** IRIs may not contain these in Turtle; percent-encode them. */
function escapeIri(value: string): string {
  return value.replace(/[\u0000- <>"{}|^`\\]/g, (c) =>
    Array.from(new TextEncoder().encode(c), (b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join("")
  );
}

const predicate = (key: string) => (key === "@type" ? "a" : key.includes(":") ? key : `schema:${key}`);
const typeTerm = (t: string) => (t.includes(":") ? t : `schema:${t}`);

function objectTerm(key: string, value: unknown, indent: string): string {
  if (key === "@type") return typeTerm(String(value));
  if (value !== null && typeof value === "object") {
    return `[\n${properties(value as Record<string, unknown>, indent + "  ")}\n${indent}]`;
  }
  const s = String(value);
  if (IRI_KEYS.has(key)) return `<${escapeIri(s)}>`;
  if (DATE_KEYS.has(key)) return `"${escapeLiteral(s)}"^^xsd:dateTime`;
  return `"${escapeLiteral(s)}"`;
}

function properties(node: Record<string, unknown>, indent: string): string {
  const lines: string[] = [];
  for (const [key, raw] of Object.entries(node)) {
    if (key === "@id" || raw === undefined) continue;
    const values = Array.isArray(raw) ? raw : [raw];
    if (values.length === 0) continue;
    const objects = values.map((v) => objectTerm(key, v, indent)).join(", ");
    lines.push(`${indent}${predicate(key)} ${objects}`);
  }
  return lines.join(" ;\n");
}

export function toTurtle(doc: PersonaDocument, publicUrl?: string): string {
  const base = baseOf(publicUrl);
  const head = [
    ...(base ? [`@base <${escapeIri(base)}> .`] : []),
    `@prefix schema: <${SCHEMA}> .`,
    `@prefix creativeid: <${CREATIVEID_NS}> .`,
    `@prefix xsd: <${XSD}> .`,
    "",
  ];
  const nodes = toPublicDocument(doc)["@graph"].map(
    (node) => `<${node["@id"]}>\n${properties(node as unknown as Record<string, unknown>, "  ")} .`
  );
  return head.join("\n") + "\n" + nodes.join("\n\n") + "\n";
}

export type LinkedDataFormat = "jsonld" | "turtle";

export function serializePersona(
  doc: PersonaDocument,
  format: LinkedDataFormat,
  publicUrl?: string
): { contentType: "application/ld+json" | "text/turtle"; content: string } {
  return format === "turtle"
    ? { contentType: "text/turtle", content: toTurtle(doc, publicUrl) }
    : { contentType: "application/ld+json", content: JSON.stringify(toPublicJsonLd(doc, publicUrl), null, 2) + "\n" };
}
