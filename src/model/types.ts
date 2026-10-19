/**
 * v2 persona model types.
 *
 * Two shapes of everything:
 * - the *node* shape is the JSON-LD stored on disk (schema.org terms where they
 *   fit, `creativeid:` terms where they don't), and
 * - the *input* shape is the plain object the API and UI work with.
 * The functions in persona.ts convert between them, so nothing outside the
 * model needs to know JSON-LD key names.
 */

export const CREATIVEID_NS = "https://www.cultureblocs.com/ns/creativeid#";

export const PERSONA_CONTEXT = {
  "@vocab": "https://schema.org/",
  foaf: "http://xmlns.com/foaf/0.1/",
  creativeid: CREATIVEID_NS,
} as const;

export const SCHEMA_VERSION = 2 as const;

// ---------------------------------------------------------------------------
// Shared value types (mirror com.cultureblocs.defs)
// ---------------------------------------------------------------------------

export interface LinkInput {
  uri: string;
  title?: string;
}

export interface ExternalIdInput {
  scheme: string;
  id: string;
  uri?: string;
}

export interface PlaceInput {
  name?: string;
  did?: string;
}

export interface CreditInput {
  name: string;
  did?: string;
  role?: string;
}

/** A connection points at a party (by DID) or at a specific record (by URI, ideally CID-pinned). */
export type SubjectInput =
  | { did: string; name?: string }
  | { uri: string; cid?: string };

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface ProfileInput {
  name: string;
  bio?: string;
  disciplines?: string[];
  based?: PlaceInput;
  links?: LinkInput[];
  externalIds?: ExternalIdInput[];
}

export interface WorkInput {
  title: string;
  referenceUrl?: string;
  completionDate?: string;
  description?: string;
  credits?: CreditInput[];
  tags?: string[];
  links?: LinkInput[];
  externalIds?: ExternalIdInput[];
}

export interface ConnectionInput {
  subject: SubjectInput;
  relationship: string;
  role?: string;
  note?: string;
}

// ---------------------------------------------------------------------------
// JSON-LD nodes
// ---------------------------------------------------------------------------

export interface LinkNode {
  "@type": "WebPage";
  url: string;
  name?: string;
}

export interface PropertyValueNode {
  "@type": "PropertyValue";
  propertyID: string;
  value: string;
  url?: string;
}

export interface PlaceNode {
  "@type": "Place";
  name?: string;
  "creativeid:did"?: string;
}

export interface CreditNode {
  "@type": "creativeid:Credit";
  name: string;
  "creativeid:did"?: string;
  "creativeid:role"?: string;
}

export type SubjectNode =
  | { "creativeid:did": string; name?: string }
  | { "creativeid:uri": string; "creativeid:cid"?: string };

export interface ProfileNode {
  "@id": "#me";
  "@type": ["Person", "creativeid:Persona"];
  name: string;
  description?: string;
  knowsAbout?: string[];
  homeLocation?: PlaceNode;
  "creativeid:links"?: LinkNode[];
  identifier?: PropertyValueNode[];
  dateCreated: string;
  dateModified: string;
}

export interface WorkNode {
  "@id": `#work-${string}`;
  "@type": ["CreativeWork", "creativeid:Work"];
  name: string;
  url?: string;
  "creativeid:completionDate"?: string;
  description?: string;
  "creativeid:credits"?: CreditNode[];
  keywords?: string[];
  "creativeid:links"?: LinkNode[];
  identifier?: PropertyValueNode[];
  dateCreated: string;
  dateModified: string;
}

export interface ConnectionNode {
  "@id": `#claim-${string}`;
  "@type": "creativeid:Connection";
  "creativeid:subject": SubjectNode;
  "creativeid:relationship": string;
  "creativeid:role"?: string;
  "creativeid:note"?: string;
  dateCreated: string;
  dateModified: string;
}

export type GraphNode = ProfileNode | WorkNode | ConnectionNode;

// ---------------------------------------------------------------------------
// Local-only state
// ---------------------------------------------------------------------------

/** Anything the creative keeps to themselves. Never read by any transformer. */
export type PrivateFields = Record<string, string>;

export interface PublishedRecord {
  uri: string;
  cid?: string;
  rkey: string;
  publishedAt: string;
}

export interface PublicationsV2 {
  atproto?: {
    did?: string;
    pdsUrl?: string;
    /** Keyed by local id: "me" for the profile, otherwise the work/connection TID. */
    records: Record<string, PublishedRecord>;
  };
  solid?: { uri: string; publishedAt: string };
  static?: { uri: string; publishedAt: string };
  /** Publication state carried over from a v1 Creative Passport file, for cleanup. */
  legacyV1?: unknown;
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

export interface PersonaDocument {
  "@context": typeof PERSONA_CONTEXT;
  "creativeid:schemaVersion": typeof SCHEMA_VERSION;
  "creativeid:personaId": string;
  /** Profile first, then works, then connections. */
  "@graph": GraphNode[];
  "creativeid:private": PrivateFields;
  "creativeid:publications": PublicationsV2;
}

/** What may leave the machine: the graph, and nothing local. */
export interface PublicPersonaDocument {
  "@context": typeof PERSONA_CONTEXT;
  "@graph": GraphNode[];
}

// ---------------------------------------------------------------------------
// Validation results
// ---------------------------------------------------------------------------

export interface Issue {
  /** Where the problem is, e.g. "profile.name", "works[2].title", "connection.subject.did". */
  path: string;
  message: string;
}

export interface ValidationReport {
  /** True when there are no errors. Warnings never block saving. */
  valid: boolean;
  errors: Issue[];
  warnings: Issue[];
}
