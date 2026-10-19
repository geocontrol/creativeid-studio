/**
 * Protocol Adapters / Transformers (Milestone 1)
 * Pure functions transforming CanonicalPersona into target protocol formats:
 * 1. Public JSON-LD (Static export & Solid JSON-LD)
 * 2. AT Protocol Lexicon record (org.creativepassport.actor.persona)
 * 3. Solid RDF Turtle (text/turtle)
 */

import {
  ATPROTO_COLLECTION_NSID,
  CanonicalPersona,
  CREATIVEID_CONTEXT,
} from "./schema.js";

export interface PublicPersonaJsonLd {
  "@context": typeof CREATIVEID_CONTEXT;
  "@id": string;
  "@type": ["Person", "creativeid:Persona"];
  name: string;
  description: string;
  "foaf:name": string;
  dateCreated: string;
  dateModified: string;
}

export interface AtprotoPersonaRecord {
  $type: typeof ATPROTO_COLLECTION_NSID;
  name: string;
  biography: string;
  updatedAt: string;
}

/**
 * Strips local-only publication tracking state and produces a clean,
 * standards-compliant JSON-LD document suitable for static hosting or Solid Pods.
 */
export function toPublicJsonLd(
  persona: CanonicalPersona,
  subjectUri?: string
): PublicPersonaJsonLd {
  return {
    "@context": CREATIVEID_CONTEXT,
    "@id": subjectUri?.trim() || persona["@id"] || "#me",
    "@type": ["Person", "creativeid:Persona"],
    name: persona.name,
    description: persona.description,
    "foaf:name": persona.name,
    dateCreated: persona.dateCreated,
    dateModified: persona.dateModified,
  };
}

/**
 * Transforms a CanonicalPersona into an AT Protocol Lexicon record
 * conforming to `org.creativepassport.actor.persona`.
 */
export function toAtprotoRecord(persona: CanonicalPersona): AtprotoPersonaRecord {
  return {
    $type: ATPROTO_COLLECTION_NSID,
    name: persona.name,
    biography: persona.description,
    updatedAt: persona.dateModified,
  };
}

/**
 * Escapes a string literal for safe embedding in an RDF Turtle double-quoted or
 * triple-quoted string literal.
 */
function escapeTurtleLiteral(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

/**
 * Transforms a CanonicalPersona into a Solid-compatible RDF Turtle (`text/turtle`) document.
 */
export function toSolidTurtle(
  persona: CanonicalPersona,
  subjectUri?: string
): string {
  const subject = subjectUri?.trim() || persona["@id"] || "#me";
  const formattedSubject = subject.startsWith("<") && subject.endsWith(">")
    ? subject
    : `<${subject}>`;

  const nameLit = escapeTurtleLiteral(persona.name);
  const bioLit = escapeTurtleLiteral(persona.description);
  const createdLit = escapeTurtleLiteral(persona.dateCreated);
  const modifiedLit = escapeTurtleLiteral(persona.dateModified);

  return [
    "@prefix schema: <https://schema.org/> .",
    "@prefix foaf: <http://xmlns.com/foaf/0.1/> .",
    "@prefix creativeid: <https://www.cultureblocs.com/ns/creativeid#> .",
    "@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .",
    "",
    `${formattedSubject}`,
    "  a schema:Person, foaf:Person, creativeid:Persona ;",
    `  schema:name "${nameLit}" ;`,
    `  foaf:name "${nameLit}" ;`,
    `  schema:description "${bioLit}" ;`,
    `  schema:dateCreated "${createdLit}"^^xsd:dateTime ;`,
    `  schema:dateModified "${modifiedLit}"^^xsd:dateTime .`,
    "",
  ].join("\n");
}
