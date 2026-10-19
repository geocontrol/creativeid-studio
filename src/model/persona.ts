/**
 * v2 persona model: one JSON-LD document per persona, holding a profile, its
 * works and its connections.
 *
 * Rules (PERSONA_STUDIO_PLAN.md, M2):
 * - Only the profile name is required. Nothing blocks saving for being
 *   incomplete; validation errors are reserved for data that could not be
 *   stored or published (over a lexicon limit, malformed URI or DID).
 * - Works and connections get a TID at creation; it becomes their ATProto rkey.
 * - `creativeid:private` and `creativeid:publications` are local-only and are
 *   stripped by toPublicDocument(); no transformer may read them.
 * - All functions are pure: they return a new document and never mutate input.
 */

import { randomBytes } from "node:crypto";
import { LEXICON_LIMITS as L } from "./limits.js";
import { isTid, nextTid } from "./tid.js";
import {
  ConnectionInput,
  ConnectionNode,
  CreditInput,
  CreditNode,
  ExternalIdInput,
  GraphNode,
  Issue,
  LinkInput,
  LinkNode,
  PERSONA_CONTEXT,
  PersonaDocument,
  PlaceInput,
  PlaceNode,
  PrivateFields,
  ProfileInput,
  ProfileNode,
  PropertyValueNode,
  PublicPersonaDocument,
  SCHEMA_VERSION,
  SubjectInput,
  SubjectNode,
  ValidationReport,
  WorkInput,
  WorkNode,
} from "./types.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class PersonaValidationError extends Error {
  readonly issues: Issue[];
  constructor(issues: Issue[]) {
    super(issues.map((i) => `${i.path}: ${i.message}`).join("; "));
    this.name = "PersonaValidationError";
    this.issues = issues;
  }
}

export class PersonaNotFoundError extends Error {
  constructor(kind: "work" | "connection", id: string) {
    super(`No ${kind} with id "${id}" in this persona.`);
    this.name = "PersonaNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

export function graphemeLength(text: string): number {
  let n = 0;
  for (const _ of segmenter.segment(text)) n++;
  return n;
}

/** Trimmed string, or undefined when empty or absent. */
function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t.length ? t : undefined;
}

function cleanList(values: unknown): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const out = values.map(clean).filter((v): v is string => v !== undefined);
  return out.length ? out : undefined;
}

/** Lexicon `uri` format: a scheme followed by a non-empty remainder (covers https:, at:, did:). */
const URI_PATTERN = /^[a-z][a-z0-9+.-]*:[^\s]+$/i;
/** Lexicon `did` format. */
const DID_PATTERN = /^did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$/;

export const isUri = (v: string) => URI_PATTERN.test(v);
export const isDid = (v: string) => DID_PATTERN.test(v);

// ---------------------------------------------------------------------------
// Normalising inputs (trim, drop empties) — always before validating
// ---------------------------------------------------------------------------

function normLinks(links: unknown): LinkInput[] | undefined {
  if (!Array.isArray(links)) return undefined;
  const out: LinkInput[] = [];
  for (const l of links) {
    const uri = clean(l?.uri);
    if (!uri) continue;
    const title = clean(l?.title);
    out.push(title ? { uri, title } : { uri });
  }
  return out.length ? out : undefined;
}

function normExternalIds(ids: unknown): ExternalIdInput[] | undefined {
  if (!Array.isArray(ids)) return undefined;
  const out: ExternalIdInput[] = [];
  for (const x of ids) {
    const scheme = clean(x?.scheme);
    const id = clean(x?.id);
    if (!scheme && !id) continue;
    const uri = clean(x?.uri);
    out.push({ scheme: scheme ?? "", id: id ?? "", ...(uri ? { uri } : {}) });
  }
  return out.length ? out : undefined;
}

function normPlace(place: unknown): PlaceInput | undefined {
  if (!place || typeof place !== "object") return undefined;
  const p = place as PlaceInput;
  const name = clean(p.name);
  const did = clean(p.did);
  if (!name && !did) return undefined;
  return { ...(name ? { name } : {}), ...(did ? { did } : {}) };
}

function normCredits(credits: unknown): CreditInput[] | undefined {
  if (!Array.isArray(credits)) return undefined;
  const out: CreditInput[] = [];
  for (const c of credits) {
    const name = clean(c?.name);
    const did = clean(c?.did);
    const role = clean(c?.role);
    if (!name && !did && !role) continue;
    out.push({ name: name ?? "", ...(did ? { did } : {}), ...(role ? { role } : {}) });
  }
  return out.length ? out : undefined;
}

function normSubject(subject: unknown): SubjectInput {
  const s = (subject ?? {}) as Record<string, unknown>;
  const did = clean(s.did);
  const uri = clean(s.uri);
  if (did && !uri) {
    const name = clean(s.name);
    return { did, ...(name ? { name } : {}) };
  }
  // Ambiguous (both or neither) inputs fall through to validation as a uri subject.
  const cid = clean(s.cid);
  return { uri: uri ?? "", ...(cid ? { cid } : {}), ...(did ? { did } : {}) } as SubjectInput;
}

export function normaliseProfileInput(input: ProfileInput): ProfileInput {
  return strip({
    name: clean(input?.name) ?? "",
    bio: clean(input?.bio),
    disciplines: cleanList(input?.disciplines),
    based: normPlace(input?.based),
    links: normLinks(input?.links),
    externalIds: normExternalIds(input?.externalIds),
  });
}

export function normaliseWorkInput(input: WorkInput): WorkInput {
  return strip({
    title: clean(input?.title) ?? "",
    referenceUrl: clean(input?.referenceUrl),
    completionDate: clean(input?.completionDate),
    description: clean(input?.description),
    credits: normCredits(input?.credits),
    tags: cleanList(input?.tags),
    links: normLinks(input?.links),
    externalIds: normExternalIds(input?.externalIds),
  });
}

export function normaliseConnectionInput(input: ConnectionInput): ConnectionInput {
  return strip({
    subject: normSubject(input?.subject),
    relationship: clean(input?.relationship) ?? "",
    role: clean(input?.role),
    note: clean(input?.note),
  });
}

/** Removes keys whose value is undefined, so stored JSON stays tidy. */
function strip<T extends object>(obj: T): T {
  for (const k of Object.keys(obj) as (keyof T)[]) {
    if (obj[k] === undefined) delete obj[k];
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Validation (expects normalised input)
// ---------------------------------------------------------------------------

class Checker {
  errors: Issue[] = [];
  warnings: Issue[] = [];
  error(path: string, message: string) {
    this.errors.push({ path, message });
  }
  warn(path: string, message: string) {
    this.warnings.push({ path, message });
  }
  required(path: string, value: string | undefined, label: string) {
    if (!value) this.error(path, `${label} is required.`);
  }
  max(path: string, value: string | undefined, limit: number) {
    if (value === undefined) return;
    const n = graphemeLength(value);
    if (n > limit) this.error(path, `Must be at most ${limit} characters (got ${n}).`);
  }
  maxItems(path: string, list: unknown[] | undefined, limit: number) {
    if (list && list.length > limit) {
      this.error(path, `At most ${limit} allowed (got ${list.length}).`);
    }
  }
  uri(path: string, value: string | undefined) {
    if (value !== undefined && !isUri(value)) {
      this.error(path, `"${value}" is not a valid URI (it needs a scheme such as https://).`);
    }
  }
  did(path: string, value: string | undefined) {
    if (value !== undefined && !isDid(value)) {
      this.error(path, `"${value}" is not a valid DID (expected did:method:identifier).`);
    }
  }
  links(path: string, links: LinkInput[] | undefined, limit: number) {
    this.maxItems(path, links, limit);
    links?.forEach((l, i) => {
      this.uri(`${path}[${i}].uri`, l.uri);
      this.max(`${path}[${i}].title`, l.title, L.defs.linkTitle);
    });
  }
  externalIds(path: string, ids: ExternalIdInput[] | undefined, limit: number) {
    this.maxItems(path, ids, limit);
    ids?.forEach((x, i) => {
      this.required(`${path}[${i}].scheme`, x.scheme, "Scheme");
      this.required(`${path}[${i}].id`, x.id, "Identifier");
      this.max(`${path}[${i}].scheme`, x.scheme, L.defs.externalIdScheme);
      this.max(`${path}[${i}].id`, x.id, L.defs.externalIdId);
      this.uri(`${path}[${i}].uri`, x.uri);
    });
  }
  report(): ValidationReport {
    return { valid: this.errors.length === 0, errors: this.errors, warnings: this.warnings };
  }
}

export function validateProfileInput(input: ProfileInput, path = "profile"): ValidationReport {
  const c = new Checker();
  c.required(`${path}.name`, input.name, "Name");
  c.max(`${path}.name`, input.name, L.profile.name);
  c.max(`${path}.bio`, input.bio, L.profile.bio);
  c.maxItems(`${path}.disciplines`, input.disciplines, L.profile.disciplines);
  input.disciplines?.forEach((d, i) => c.max(`${path}.disciplines[${i}]`, d, L.profile.discipline));
  c.max(`${path}.based.name`, input.based?.name, L.defs.placeName);
  c.did(`${path}.based.did`, input.based?.did);
  c.links(`${path}.links`, input.links, L.profile.links);
  c.externalIds(`${path}.externalIds`, input.externalIds, L.profile.externalIds);
  return c.report();
}

export function validateWorkInput(input: WorkInput, path = "work"): ValidationReport {
  const c = new Checker();
  c.required(`${path}.title`, input.title, "Title");
  c.max(`${path}.title`, input.title, L.work.title);
  c.uri(`${path}.referenceUrl`, input.referenceUrl);
  c.max(`${path}.completionDate`, input.completionDate, L.work.completionDate);
  c.max(`${path}.description`, input.description, L.work.description);
  c.maxItems(`${path}.credits`, input.credits, L.work.credits);
  input.credits?.forEach((cr, i) => {
    c.required(`${path}.credits[${i}].name`, cr.name, "Credit name");
    c.max(`${path}.credits[${i}].name`, cr.name, L.defs.creditName);
    c.did(`${path}.credits[${i}].did`, cr.did);
    c.max(`${path}.credits[${i}].role`, cr.role, L.defs.creditRole);
  });
  c.maxItems(`${path}.tags`, input.tags, L.work.tags);
  input.tags?.forEach((t, i) => c.max(`${path}.tags[${i}]`, t, L.work.tag));
  c.links(`${path}.links`, input.links, L.work.links);
  c.externalIds(`${path}.externalIds`, input.externalIds, L.work.externalIds);
  return c.report();
}

export function validateConnectionInput(
  input: ConnectionInput,
  path = "connection"
): ValidationReport {
  const c = new Checker();
  const s = input.subject as Record<string, string | undefined>;
  if (s.did && s.uri) {
    c.error(`${path}.subject`, "Point at either a party (DID) or a record (URI), not both.");
  } else if ("did" in s && s.did) {
    c.did(`${path}.subject.did`, s.did);
    c.max(`${path}.subject.name`, s.name, L.defs.didRefName);
  } else if (!s.uri) {
    c.error(`${path}.subject`, "A connection needs a subject: a DID or a record URI.");
  } else {
    c.uri(`${path}.subject.uri`, s.uri);
    if (!s.cid) {
      c.warn(
        `${path}.subject.cid`,
        "Not pinned to a CID, so later edits to the target record can't be detected."
      );
    }
  }
  c.required(`${path}.relationship`, input.relationship, "Relationship");
  c.max(`${path}.relationship`, input.relationship, L.connection.relationship);
  c.max(`${path}.role`, input.role, L.connection.role);
  c.max(`${path}.note`, input.note, L.connection.note);
  return c.report();
}

function assertValid(report: ValidationReport): void {
  if (!report.valid) throw new PersonaValidationError(report.errors);
}

// ---------------------------------------------------------------------------
// Input <-> node conversion
// ---------------------------------------------------------------------------

const toLinkNodes = (links?: LinkInput[]): LinkNode[] | undefined =>
  links?.map((l) => strip({ "@type": "WebPage" as const, url: l.uri, name: l.title }));

const fromLinkNodes = (nodes?: LinkNode[]): LinkInput[] | undefined =>
  nodes?.map((n) => strip({ uri: n.url, title: n.name }));

const toIdNodes = (ids?: ExternalIdInput[]): PropertyValueNode[] | undefined =>
  ids?.map((x) =>
    strip({ "@type": "PropertyValue" as const, propertyID: x.scheme, value: x.id, url: x.uri })
  );

const fromIdNodes = (nodes?: PropertyValueNode[]): ExternalIdInput[] | undefined =>
  nodes?.map((n) => strip({ scheme: n.propertyID, id: n.value, uri: n.url }));

const toPlaceNode = (p?: PlaceInput): PlaceNode | undefined =>
  p && strip({ "@type": "Place" as const, name: p.name, "creativeid:did": p.did });

const fromPlaceNode = (n?: PlaceNode): PlaceInput | undefined =>
  n && strip({ name: n.name, did: n["creativeid:did"] });

const toCreditNodes = (credits?: CreditInput[]): CreditNode[] | undefined =>
  credits?.map((cr) =>
    strip({
      "@type": "creativeid:Credit" as const,
      name: cr.name,
      "creativeid:did": cr.did,
      "creativeid:role": cr.role,
    })
  );

const fromCreditNodes = (nodes?: CreditNode[]): CreditInput[] | undefined =>
  nodes?.map((n) => strip({ name: n.name, did: n["creativeid:did"], role: n["creativeid:role"] }));

function toSubjectNode(s: SubjectInput): SubjectNode {
  return "did" in s
    ? strip({ "creativeid:did": s.did, name: s.name })
    : strip({ "creativeid:uri": s.uri, "creativeid:cid": s.cid });
}

function fromSubjectNode(n: SubjectNode): SubjectInput {
  return "creativeid:did" in n
    ? strip({ did: n["creativeid:did"], name: n.name })
    : strip({ uri: n["creativeid:uri"], cid: n["creativeid:cid"] });
}

export function toProfileInput(node: ProfileNode): ProfileInput {
  return strip({
    name: node.name,
    bio: node.description,
    disciplines: node.knowsAbout,
    based: fromPlaceNode(node.homeLocation),
    links: fromLinkNodes(node["creativeid:links"]),
    externalIds: fromIdNodes(node.identifier),
  });
}

export function toWorkInput(node: WorkNode): WorkInput {
  return strip({
    title: node.name,
    referenceUrl: node.url,
    completionDate: node["creativeid:completionDate"],
    description: node.description,
    credits: fromCreditNodes(node["creativeid:credits"]),
    tags: node.keywords,
    links: fromLinkNodes(node["creativeid:links"]),
    externalIds: fromIdNodes(node.identifier),
  });
}

export function toConnectionInput(node: ConnectionNode): ConnectionInput {
  return strip({
    subject: fromSubjectNode(node["creativeid:subject"]),
    relationship: node["creativeid:relationship"],
    role: node["creativeid:role"],
    note: node["creativeid:note"],
  });
}

function buildProfileNode(input: ProfileInput, created: string, modified: string): ProfileNode {
  return strip({
    "@id": "#me" as const,
    "@type": ["Person", "creativeid:Persona"] as ["Person", "creativeid:Persona"],
    name: input.name,
    description: input.bio,
    knowsAbout: input.disciplines,
    homeLocation: toPlaceNode(input.based),
    "creativeid:links": toLinkNodes(input.links),
    identifier: toIdNodes(input.externalIds),
    dateCreated: created,
    dateModified: modified,
  });
}

function buildWorkNode(id: string, input: WorkInput, created: string, modified: string): WorkNode {
  return strip({
    "@id": `#work-${id}` as const,
    "@type": ["CreativeWork", "creativeid:Work"] as ["CreativeWork", "creativeid:Work"],
    name: input.title,
    url: input.referenceUrl,
    "creativeid:completionDate": input.completionDate,
    description: input.description,
    "creativeid:credits": toCreditNodes(input.credits),
    keywords: input.tags,
    "creativeid:links": toLinkNodes(input.links),
    identifier: toIdNodes(input.externalIds),
    dateCreated: created,
    dateModified: modified,
  });
}

function buildConnectionNode(
  id: string,
  input: ConnectionInput,
  created: string,
  modified: string
): ConnectionNode {
  return strip({
    "@id": `#claim-${id}` as const,
    "@type": "creativeid:Connection" as const,
    "creativeid:subject": toSubjectNode(input.subject),
    "creativeid:relationship": input.relationship,
    "creativeid:role": input.role,
    "creativeid:note": input.note,
    dateCreated: created,
    dateModified: modified,
  });
}

// ---------------------------------------------------------------------------
// Graph access
// ---------------------------------------------------------------------------

const isProfile = (n: GraphNode): n is ProfileNode => n["@id"] === "#me";
const isWork = (n: GraphNode): n is WorkNode => n["@id"].startsWith("#work-");
const isConnection = (n: GraphNode): n is ConnectionNode => n["@id"].startsWith("#claim-");

/** The local id (TID) of a work or connection node. */
export function localIdOf(node: WorkNode | ConnectionNode): string {
  return node["@id"].slice(node["@id"].indexOf("-") + 1);
}

export function getProfile(doc: PersonaDocument): ProfileNode {
  const p = doc["@graph"].find(isProfile);
  if (!p) throw new Error("Persona document has no profile node (#me).");
  return p;
}

export const getWorks = (doc: PersonaDocument): WorkNode[] => doc["@graph"].filter(isWork);
export const getConnections = (doc: PersonaDocument): ConnectionNode[] =>
  doc["@graph"].filter(isConnection);

export const findWork = (doc: PersonaDocument, id: string): WorkNode | undefined =>
  getWorks(doc).find((w) => localIdOf(w) === id);
export const findConnection = (doc: PersonaDocument, id: string): ConnectionNode | undefined =>
  getConnections(doc).find((c) => localIdOf(c) === id);

/** Rebuilds the graph in canonical order: profile, works, connections. */
function withGraph(
  doc: PersonaDocument,
  profile: ProfileNode,
  works: WorkNode[],
  connections: ConnectionNode[]
): PersonaDocument {
  return structuredClone({ ...doc, "@graph": [profile, ...works, ...connections] });
}

// ---------------------------------------------------------------------------
// Persona ids
// ---------------------------------------------------------------------------

const S32 = "234567abcdefghijklmnopqrstuvwxyz";

/**
 * A local, human-readable persona id: a slug of the name plus a short random
 * suffix. Never derived from a DID — a persona exists before it is published.
 */
export function makePersonaId(name: string): string {
  const slug =
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "persona";
  const suffix = Array.from(randomBytes(4), (b) => S32[b & 31]).join("");
  return `${slug}-${suffix}`;
}

const PERSONA_ID_PATTERN = /^[a-z0-9-]{1,48}$/;
export const isPersonaId = (v: string) => PERSONA_ID_PATTERN.test(v) && !v.startsWith("-");

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export interface CreateOptions {
  now?: Date;
  personaId?: string;
}

export function createPersonaDocument(
  input: ProfileInput,
  options: CreateOptions = {}
): PersonaDocument {
  const profileInput = normaliseProfileInput(input);
  assertValid(validateProfileInput(profileInput));
  const ts = (options.now ?? new Date()).toISOString();
  const personaId = options.personaId ?? makePersonaId(profileInput.name);
  if (!isPersonaId(personaId)) {
    throw new PersonaValidationError([
      { path: "personaId", message: `"${personaId}" is not a valid persona id.` },
    ]);
  }
  return {
    "@context": PERSONA_CONTEXT,
    "creativeid:schemaVersion": SCHEMA_VERSION,
    "creativeid:personaId": personaId,
    "@graph": [buildProfileNode(profileInput, ts, ts)],
    "creativeid:private": {},
    "creativeid:publications": {},
  };
}

/** Replaces every editable profile field with `input` (absent optional fields are cleared). */
export function updateProfile(
  doc: PersonaDocument,
  input: ProfileInput,
  now: Date = new Date()
): PersonaDocument {
  const profileInput = normaliseProfileInput(input);
  assertValid(validateProfileInput(profileInput));
  const current = getProfile(doc);
  const next = buildProfileNode(profileInput, current.dateCreated, now.toISOString());
  return withGraph(doc, next, getWorks(doc), getConnections(doc));
}

export interface AddOptions {
  now?: Date;
  /** Supply a TID (e.g. when importing); one is generated otherwise. */
  id?: string;
}

export function addWork(
  doc: PersonaDocument,
  input: WorkInput,
  options: AddOptions = {}
): { document: PersonaDocument; id: string } {
  const workInput = normaliseWorkInput(input);
  assertValid(validateWorkInput(workInput));
  const now = options.now ?? new Date();
  const id = options.id ?? nextTid(now);
  if (!isTid(id)) {
    throw new PersonaValidationError([{ path: "work.id", message: `"${id}" is not a TID.` }]);
  }
  if (findWork(doc, id)) {
    throw new PersonaValidationError([{ path: "work.id", message: `Work "${id}" already exists.` }]);
  }
  const ts = now.toISOString();
  const works = [...getWorks(doc), buildWorkNode(id, workInput, ts, ts)];
  return { document: withGraph(doc, getProfile(doc), works, getConnections(doc)), id };
}

/** Replaces every editable field of one work. */
export function updateWork(
  doc: PersonaDocument,
  id: string,
  input: WorkInput,
  now: Date = new Date()
): PersonaDocument {
  const current = findWork(doc, id);
  if (!current) throw new PersonaNotFoundError("work", id);
  const workInput = normaliseWorkInput(input);
  assertValid(validateWorkInput(workInput));
  const next = buildWorkNode(id, workInput, current.dateCreated, now.toISOString());
  const works = getWorks(doc).map((w) => (w === current ? next : w));
  return withGraph(doc, getProfile(doc), works, getConnections(doc));
}

export function removeWork(doc: PersonaDocument, id: string): PersonaDocument {
  if (!findWork(doc, id)) throw new PersonaNotFoundError("work", id);
  const works = getWorks(doc).filter((w) => localIdOf(w) !== id);
  return withGraph(doc, getProfile(doc), works, getConnections(doc));
}

export function addConnection(
  doc: PersonaDocument,
  input: ConnectionInput,
  options: AddOptions = {}
): { document: PersonaDocument; id: string; warnings: Issue[] } {
  const connInput = normaliseConnectionInput(input);
  const report = validateConnectionInput(connInput);
  assertValid(report);
  const now = options.now ?? new Date();
  const id = options.id ?? nextTid(now);
  if (!isTid(id)) {
    throw new PersonaValidationError([{ path: "connection.id", message: `"${id}" is not a TID.` }]);
  }
  if (findConnection(doc, id)) {
    throw new PersonaValidationError([
      { path: "connection.id", message: `Connection "${id}" already exists.` },
    ]);
  }
  const ts = now.toISOString();
  const connections = [...getConnections(doc), buildConnectionNode(id, connInput, ts, ts)];
  return {
    document: withGraph(doc, getProfile(doc), getWorks(doc), connections),
    id,
    warnings: report.warnings,
  };
}

/** Replaces every editable field of one connection. */
export function updateConnection(
  doc: PersonaDocument,
  id: string,
  input: ConnectionInput,
  now: Date = new Date()
): PersonaDocument {
  const current = findConnection(doc, id);
  if (!current) throw new PersonaNotFoundError("connection", id);
  const connInput = normaliseConnectionInput(input);
  assertValid(validateConnectionInput(connInput));
  const next = buildConnectionNode(id, connInput, current.dateCreated, now.toISOString());
  const connections = getConnections(doc).map((c) => (c === current ? next : c));
  return withGraph(doc, getProfile(doc), getWorks(doc), connections);
}

export function removeConnection(doc: PersonaDocument, id: string): PersonaDocument {
  if (!findConnection(doc, id)) throw new PersonaNotFoundError("connection", id);
  const connections = getConnections(doc).filter((c) => localIdOf(c) !== id);
  return withGraph(doc, getProfile(doc), getWorks(doc), connections);
}

/** Sets (or, with an empty/undefined value, removes) a private field. Never published. */
export function setPrivateField(
  doc: PersonaDocument,
  key: string,
  value: string | undefined
): PersonaDocument {
  const k = clean(key);
  if (!k) throw new PersonaValidationError([{ path: "private", message: "Key is required." }]);
  const next: PrivateFields = { ...doc["creativeid:private"] };
  const v = clean(value);
  if (v === undefined) delete next[k];
  else next[k] = v;
  return structuredClone({ ...doc, "creativeid:private": next });
}

// ---------------------------------------------------------------------------
// Whole-document checks
// ---------------------------------------------------------------------------

/**
 * Validates a document read from disk: structure, ids, and every node against
 * the lexicon limits. Use it before trusting a file someone may have edited.
 */
export function validateDocument(doc: PersonaDocument): ValidationReport {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  if (doc?.["creativeid:schemaVersion"] !== SCHEMA_VERSION) {
    errors.push({ path: "schemaVersion", message: `Expected schema version ${SCHEMA_VERSION}.` });
  }
  if (!isPersonaId(String(doc?.["creativeid:personaId"] ?? ""))) {
    errors.push({ path: "personaId", message: "Missing or invalid persona id." });
  }
  const graph = Array.isArray(doc?.["@graph"]) ? doc["@graph"] : [];
  const profiles = graph.filter(isProfile);
  if (profiles.length !== 1) {
    errors.push({ path: "@graph", message: `Expected exactly one profile node (got ${profiles.length}).` });
  }
  const seen = new Set<string>();
  graph.forEach((n, i) => {
    const id = n?.["@id"];
    if (seen.has(id)) errors.push({ path: `@graph[${i}]`, message: `Duplicate @id "${id}".` });
    seen.add(id);
    if (!isProfile(n) && !isWork(n) && !isConnection(n)) {
      errors.push({ path: `@graph[${i}]`, message: `Unknown node @id "${id}".` });
    }
  });
  const merge = (r: ValidationReport) => {
    errors.push(...r.errors);
    warnings.push(...r.warnings);
  };
  profiles.forEach((p) => merge(validateProfileInput(toProfileInput(p))));
  graph.filter(isWork).forEach((w, i) => {
    if (!isTid(localIdOf(w))) errors.push({ path: `works[${i}]`, message: "Id is not a TID." });
    merge(validateWorkInput(toWorkInput(w), `works[${i}]`));
  });
  graph.filter(isConnection).forEach((c, i) => {
    if (!isTid(localIdOf(c))) errors.push({ path: `connections[${i}]`, message: "Id is not a TID." });
    merge(validateConnectionInput(toConnectionInput(c), `connections[${i}]`));
  });
  return { valid: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// What may leave the machine
// ---------------------------------------------------------------------------

/**
 * The public view of a persona: the graph and its context, with every
 * local-only key (persona id, private fields, publication state) removed.
 * Every transformer and publisher must start from this, never from the
 * stored document.
 */
export function toPublicDocument(doc: PersonaDocument): PublicPersonaDocument {
  return structuredClone({ "@context": doc["@context"], "@graph": doc["@graph"] });
}

// ---------------------------------------------------------------------------
// v1 import
// ---------------------------------------------------------------------------

/** The v1 single-persona file (data/persona.jsonld), before or after the M1 rename. */
export interface V1PersonaFile {
  name: string;
  description?: string;
  dateCreated?: string;
  dateModified?: string;
  "creativeid:publications"?: unknown;
  "cp:publications"?: unknown;
}

/**
 * Converts a v1 Creative Passport persona into a v2 document. Its publication
 * state is kept under `legacyV1` so the cleanup script can find and remove
 * records published under the old org.creativepassport.* schema.
 */
export function fromV1(v1: V1PersonaFile, options: CreateOptions = {}): PersonaDocument {
  const now = options.now ?? new Date();
  const doc = createPersonaDocument({ name: v1.name, bio: v1.description }, { ...options, now });
  const profile = getProfile(doc);
  profile.dateCreated = v1.dateCreated ?? profile.dateCreated;
  profile.dateModified = v1.dateModified ?? profile.dateModified;
  const legacy = v1["creativeid:publications"] ?? v1["cp:publications"];
  if (legacy && typeof legacy === "object" && Object.keys(legacy).length) {
    doc["creativeid:publications"] = { legacyV1: structuredClone(legacy) };
  }
  return doc;
}
