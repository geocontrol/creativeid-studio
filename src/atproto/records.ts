/**
 * Persona → ATProto records (`src/atproto/records.ts`) — M4.
 *
 * One persona publishes as:
 *   com.cultureblocs.creative.profile     rkey "self"
 *   com.cultureblocs.creative.work        rkey = the work's local TID
 *   com.cultureblocs.creative.connection  rkey = the connection's local TID
 *
 * Records are built from toPublicDocument() only, so private fields and local
 * state cannot reach a PDS. Every record is validated against the vendored
 * CultureBlocs lexicons before it is returned.
 *
 * `createdAt` is the local creation date — the lexicons' one immutable field —
 * so it never changes however often a record is republished.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LexiconDoc, Lexicons } from "@atproto/lexicon";

import {
  ConnectionNode,
  getConnections,
  getProfile,
  getWorks,
  localIdOf,
  PersonaDocument,
  ProfileNode,
  toConnectionInput,
  toProfileInput,
  toPublicDocument,
  toWorkInput,
  WorkNode,
} from "../model/index.js";

export const NSID = {
  profile: "com.cultureblocs.creative.profile",
  work: "com.cultureblocs.creative.work",
  connection: "com.cultureblocs.creative.connection",
  didRef: "com.cultureblocs.defs#didRef",
  strongRef: "com.cultureblocs.defs#strongRef",
} as const;

/** The collection the v1 Creative Passport prototype wrote to. Only the cleanup tool uses it. */
export const LEGACY_NSID = "org.creativepassport.actor.persona";

export const PROFILE_RKEY = "self";
/** Key for the profile in local publication state. */
export const PROFILE_LOCAL_ID = "me";

export type Collection = (typeof NSID)["profile" | "work" | "connection"];

export interface PlannedRecord {
  /** "me" for the profile, otherwise the work/connection TID. */
  localId: string;
  collection: Collection;
  rkey: string;
  record: Record<string, unknown>;
  /** Local last-modified time, used to tell new/changed/unchanged apart. */
  dateModified: string;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** Drops undefined values and empty arrays so records stay minimal. */
function compact<T extends Record<string, unknown>>(obj: T): T {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || (Array.isArray(v) && v.length === 0)) delete obj[k];
  }
  return obj;
}

export function toProfileRecord(node: ProfileNode): Record<string, unknown> {
  const p = toProfileInput(node);
  return compact({
    $type: NSID.profile,
    name: p.name,
    bio: p.bio,
    disciplines: p.disciplines,
    based: p.based && compact({ name: p.based.name, did: p.based.did }),
    links: p.links?.map((l) => compact({ uri: l.uri, title: l.title })),
    externalIds: p.externalIds?.map((x) => compact({ scheme: x.scheme, id: x.id, uri: x.uri })),
    createdAt: node.dateCreated,
  });
}

export function toWorkRecord(node: WorkNode): Record<string, unknown> {
  const w = toWorkInput(node);
  return compact({
    $type: NSID.work,
    title: w.title,
    referenceUrl: w.referenceUrl,
    completionDate: w.completionDate,
    description: w.description,
    credits: w.credits?.map((c) => compact({ name: c.name, did: c.did, role: c.role })),
    tags: w.tags,
    links: w.links?.map((l) => compact({ uri: l.uri, title: l.title })),
    externalIds: w.externalIds?.map((x) => compact({ scheme: x.scheme, id: x.id, uri: x.uri })),
    createdAt: node.dateCreated,
  });
}

export function toConnectionRecord(node: ConnectionNode): Record<string, unknown> {
  const c = toConnectionInput(node);
  const subject =
    "did" in c.subject
      ? compact({ $type: NSID.didRef, did: c.subject.did, name: c.subject.name })
      : compact({ $type: NSID.strongRef, uri: c.subject.uri, cid: c.subject.cid });
  return compact({
    $type: NSID.connection,
    subject,
    relationship: c.relationship,
    role: c.role,
    note: c.note,
    createdAt: node.dateCreated,
  });
}

// ---------------------------------------------------------------------------
// Validation against the vendored lexicons
// ---------------------------------------------------------------------------

const LEXICON_FILES = ["defs", "creative/profile", "creative/work", "creative/connection"];
let lexicons: Lexicons | undefined;

function loadLexicons(): Lexicons {
  if (lexicons) return lexicons;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "lexicons", "com", "cultureblocs");
  const lex = new Lexicons();
  for (const f of LEXICON_FILES) {
    lex.add(JSON.parse(readFileSync(join(root, `${f}.json`), "utf8")) as LexiconDoc);
  }
  lexicons = lex;
  return lex;
}

export class RecordValidationError extends Error {
  constructor(public readonly localId: string, public readonly collection: string, detail: string) {
    super(`${collection} record "${localId}" does not match the lexicon: ${detail}`);
    this.name = "RecordValidationError";
  }
}

export function assertValidRecord(planned: PlannedRecord): void {
  try {
    loadLexicons().assertValidRecord(planned.collection, planned.record);
  } catch (err) {
    throw new RecordValidationError(planned.localId, planned.collection, (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Whole persona
// ---------------------------------------------------------------------------

/** Every record a persona publishes, validated, profile first. */
export function toAtprotoRecords(doc: PersonaDocument): PlannedRecord[] {
  const pub = toPublicDocument(doc);
  const profile = getProfile(pub);
  const planned: PlannedRecord[] = [
    {
      localId: PROFILE_LOCAL_ID,
      collection: NSID.profile,
      rkey: PROFILE_RKEY,
      record: toProfileRecord(profile),
      dateModified: profile.dateModified,
    },
    ...getWorks(pub).map((w) => ({
      localId: localIdOf(w),
      collection: NSID.work,
      rkey: localIdOf(w),
      record: toWorkRecord(w),
      dateModified: w.dateModified,
    })),
    ...getConnections(pub).map((c) => ({
      localId: localIdOf(c),
      collection: NSID.connection,
      rkey: localIdOf(c),
      record: toConnectionRecord(c),
      dateModified: c.dateModified,
    })),
  ];
  planned.forEach(assertValidRecord);
  return planned;
}

/** The collection a published record lives in, read back from its at:// URI. */
export function collectionOfUri(uri: string): string | undefined {
  return uri.match(/^at:\/\/[^/]+\/([^/]+)\//)?.[1];
}

export interface PublishPlan {
  create: PlannedRecord[];
  update: PlannedRecord[];
  unchanged: PlannedRecord[];
  /** Previously published records that no longer exist locally. */
  delete: { localId: string; collection: string; rkey: string; uri: string }[];
}

/**
 * What a publish would do, compared with the last publish to this persona's
 * account: new records, records edited since they were published, and
 * records deleted locally that must be deleted remotely too.
 */
export function planPublish(doc: PersonaDocument): PublishPlan {
  const records = toAtprotoRecords(doc);
  const published = doc["creativeid:publications"].atproto?.records ?? {};
  const plan: PublishPlan = { create: [], update: [], unchanged: [], delete: [] };
  for (const r of records) {
    const prev = published[r.localId];
    // A record last published to another collection (the v1 profile) is new here.
    if (!prev || collectionOfUri(prev.uri) !== r.collection) plan.create.push(r);
    else if (r.dateModified > prev.publishedAt) plan.update.push(r);
    else plan.unchanged.push(r);
  }
  const current = new Set(records.map((r) => r.localId));
  for (const [localId, prev] of Object.entries(published)) {
    if (!current.has(localId) && collectionOfUri(prev.uri) !== LEGACY_NSID) {
      plan.delete.push({ localId, collection: collectionOfUri(prev.uri) ?? "", rkey: prev.rkey, uri: prev.uri });
    }
  }
  return plan;
}
