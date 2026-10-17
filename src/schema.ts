/**
 * Canonical JSON-LD Schema and Validation for Creative Passport v1
 */

export const CREATIVE_PASSPORT_CONTEXT = {
  "@vocab": "https://schema.org/",
  foaf: "http://xmlns.com/foaf/0.1/",
  cp: "https://creativepassport.org/ns#",
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
  "@context": typeof CREATIVE_PASSPORT_CONTEXT;
  "@id": string;
  "@type": ["Person", "cp:CreativePersona"];
  name: string;
  description: string;
  dateCreated: string;
  dateModified: string;
  "cp:publications"?: PublicationsMap;
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
    "@context": CREATIVE_PASSPORT_CONTEXT,
    "@id": input.id?.trim() || "#me",
    "@type": ["Person", "cp:CreativePersona"],
    name: input.name.trim(),
    description: input.biography.trim(),
    dateCreated: timestamp,
    dateModified: timestamp,
    "cp:publications": {},
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
    "@context": CREATIVE_PASSPORT_CONTEXT,
    "@id": input.id?.trim() || existing["@id"] || "#me",
    "@type": ["Person", "cp:CreativePersona"],
    name: input.name.trim(),
    description: input.biography.trim(),
    dateModified: now.toISOString(),
  };
}
