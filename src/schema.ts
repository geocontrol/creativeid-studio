/**
 * Canonical JSON-LD Schema and Validation for CreativeID v1
 */

export const CREATIVEID_CONTEXT = {
  "@vocab": "https://schema.org/",
  foaf: "http://xmlns.com/foaf/0.1/",
  creativeid: "https://www.cultureblocs.com/ns/creativeid#",
} as const;

export const ATPROTO_COLLECTION_NSID = "org.creativepassport.actor.persona";
export const ATPROTO_RECORD_KEY = "self";

export const LIMITS = {
  NAME_MAX_GRAPHEMES: 64,
  NAME_MAX_BYTES: 640,
  BIO_MAX_GRAPHEMES: 1000,
  BIO_MAX_BYTES: 10000,
} as const;

export interface PublicationStatus {
  uri: string;
  cid?: string;
  publishedAt: string;
}

export interface PublicationsMap {
  atproto?: PublicationStatus;
  solid?: PublicationStatus;
  static?: PublicationStatus;
}

export interface CanonicalPersona {
  "@context": typeof CREATIVEID_CONTEXT;
  "@id": string;
  "@type": ["Person", "creativeid:Persona"];
  name: string;
  description: string;
  dateCreated: string;
  dateModified: string;
  "creativeid:publications"?: PublicationsMap;
}

export interface PersonaInput {
  name: string;
  biography: string;
  id?: string;
}

export interface ValidationIssue {
  field: "name" | "biography";
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

export function countGraphemes(text: string): number {
  let count = 0;
  for (const _ of segmenter.segment(text)) {
    count++;
  }
  return count;
}

export function validatePersonaInput(input: PersonaInput): ValidationResult {
  const issues: ValidationIssue[] = [];
  const trimmedName = (input.name ?? "").trim();
  const trimmedBio = (input.biography ?? "").trim();

  if (!trimmedName) {
    issues.push({
      field: "name",
      message: "Persona name is required.",
    });
  } else {
    const nameGraphemes = countGraphemes(trimmedName);
    const nameBytes = Buffer.byteLength(trimmedName, "utf8");
    if (nameGraphemes > LIMITS.NAME_MAX_GRAPHEMES) {
      issues.push({
        field: "name",
        message: `Persona name must be at most ${LIMITS.NAME_MAX_GRAPHEMES} graphemes (got ${nameGraphemes}).`,
      });
    } else if (nameBytes > LIMITS.NAME_MAX_BYTES) {
      issues.push({
        field: "name",
        message: `Persona name must be at most ${LIMITS.NAME_MAX_BYTES} bytes.`,
      });
    }
  }

  if (!trimmedBio) {
    issues.push({
      field: "biography",
      message: "Biography is required.",
    });
  } else {
    const bioGraphemes = countGraphemes(trimmedBio);
    const bioBytes = Buffer.byteLength(trimmedBio, "utf8");
    if (bioGraphemes > LIMITS.BIO_MAX_GRAPHEMES) {
      issues.push({
        field: "biography",
        message: `Biography must be at most ${LIMITS.BIO_MAX_GRAPHEMES} graphemes (got ${bioGraphemes}).`,
      });
    } else if (bioBytes > LIMITS.BIO_MAX_BYTES) {
      issues.push({
        field: "biography",
        message: `Biography must be at most ${LIMITS.BIO_MAX_BYTES} bytes.`,
      });
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

export function createCanonicalPersona(
  input: PersonaInput,
  now: Date = new Date()
): CanonicalPersona {
  const validation = validatePersonaInput(input);
  if (!validation.valid) {
    const messages = validation.issues.map((i) => `${i.field}: ${i.message}`).join("; ");
    throw new Error(`Invalid persona input: ${messages}`);
  }

  const timestamp = now.toISOString();
  return {
    "@context": CREATIVEID_CONTEXT,
    "@id": input.id?.trim() || "#me",
    "@type": ["Person", "creativeid:Persona"],
    name: input.name.trim(),
    description: input.biography.trim(),
    dateCreated: timestamp,
    dateModified: timestamp,
    "creativeid:publications": {},
  };
}

export function updateCanonicalPersona(
  existing: CanonicalPersona,
  input: PersonaInput,
  now: Date = new Date()
): CanonicalPersona {
  const validation = validatePersonaInput(input);
  if (!validation.valid) {
    const messages = validation.issues.map((i) => `${i.field}: ${i.message}`).join("; ");
    throw new Error(`Invalid persona input: ${messages}`);
  }

  return {
    ...existing,
    "@context": CREATIVEID_CONTEXT,
    "@id": input.id?.trim() || existing["@id"] || "#me",
    "@type": ["Person", "creativeid:Persona"],
    name: input.name.trim(),
    description: input.biography.trim(),
    dateModified: now.toISOString(),
  };
}
