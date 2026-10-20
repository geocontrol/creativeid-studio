/**
 * AT Protocol PDS adapter (`src/adapters/atproto.ts`) — M4.
 *
 * Publishes a whole persona as com.cultureblocs.creative.* records:
 * - every record is validated against the vendored lexicons first;
 * - records are written with putRecord at a stable rkey (profile "self",
 *   works and connections by their local TID), so republishing updates in
 *   place and never duplicates;
 * - records deleted locally are deleted from the PDS;
 * - a v1 `org.creativepassport.actor.persona` record this tool wrote earlier
 *   to the same account is removed;
 * - one persona = one account: a persona bound to one DID refuses to publish
 *   to another, and the caller can refuse a DID another persona already uses.
 * If a write fails part-way, PublishFailedError carries what did succeed so
 * local state can still record it.
 */

import { PersonaDocument, PublicationsV2, PublishedRecord } from "../model/index.js";
import { LEGACY_NSID, planPublish, PlannedRecord, PublishPlan } from "../atproto/records.js";

export interface AtprotoCredentials {
  /** Base URL of the PDS, e.g. "https://bsky.social" or a self-hosted PDS. */
  pdsUrl: string;
  /** Handle ("alice.bsky.social") or DID. With `accessJwt`, this must be the DID. */
  identifier: string;
  /** App Password. Used for this request only and never stored. */
  password?: string;
  accessJwt?: string;
}

export interface AtprotoPublishOptions extends AtprotoCredentials {
  fetchImpl?: typeof fetch;
  now?: Date;
  /** Called with the account's DID before anything is written; throw to stop. */
  assertAccount?: (did: string) => void | Promise<void>;
}

export interface AtprotoPublishResult {
  did: string;
  /** The handle the account signed in with, when known. */
  handle?: string;
  pdsUrl: string;
  /** Every record now live for this persona, keyed by local id ("me" = profile). */
  records: Record<string, PublishedRecord>;
  created: string[];
  updated: string[];
  unchanged: string[];
  /** URIs deleted from the PDS (records removed locally, and legacy v1 records). */
  deleted: string[];
  publishedAt: string;
}

export class AccountMismatchError extends Error {
  constructor(public readonly boundDid: string, public readonly sessionDid: string) {
    super(
      `This persona is published from ${boundDid}, but these credentials sign in as ${sessionDid}. ` +
        "A persona can only publish to one account."
    );
    this.name = "AccountMismatchError";
  }
}

export class PublishFailedError extends Error {
  constructor(message: string, public readonly partial: AtprotoPublishResult) {
    super(message);
    this.name = "PublishFailedError";
  }
}

// ---------------------------------------------------------------------------
// XRPC helpers
// ---------------------------------------------------------------------------

export function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(`Invalid PDS URL "${url}": must start with http:// or https://`);
  }
  return trimmed;
}

async function xrpc<T>(
  fetchImpl: typeof fetch,
  baseUrl: string,
  method: "GET" | "POST",
  nsid: string,
  options: { params?: Record<string, string>; body?: unknown; token?: string } = {}
): Promise<T> {
  const query = options.params ? `?${new URLSearchParams(options.params)}` : "";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetchImpl(`${baseUrl}/xrpc/${nsid}${query}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const err = new Error(`ATProto ${nsid} failed (${response.status} ${response.statusText}): ${text}`);
    (err as Error & { status?: number; body?: string }).status = response.status;
    (err as Error & { status?: number; body?: string }).body = text;
    throw err;
  }
  const text = await response.text();
  return (text ? JSON.parse(text) : {}) as T;
}

const isNotFound = (err: unknown) => {
  const e = err as { status?: number; body?: string };
  return e?.status === 404 || (e?.status === 400 && /RecordNotFound|Could not locate record/i.test(e.body ?? ""));
};

export interface AtprotoSession {
  did: string;
  handle?: string;
  accessJwt: string;
}

/** Signs in with an App Password, or uses a supplied access token with a DID. */
export async function openAtprotoSession(
  credentials: AtprotoCredentials,
  fetchImpl: typeof fetch = fetch
): Promise<AtprotoSession> {
  const baseUrl = normalizeBaseUrl(credentials.pdsUrl);
  const identifier = credentials.identifier.trim();
  if (!identifier) throw new Error("ATProto identifier (handle or DID) is required.");
  if (credentials.accessJwt) {
    if (!identifier.startsWith("did:")) {
      throw new Error("When publishing with an access token, the identifier must be the account's DID.");
    }
    return { did: identifier, accessJwt: credentials.accessJwt };
  }
  if (!credentials.password) {
    throw new Error("An App Password (or an access token) is required to publish to ATProto.");
  }
  return xrpc<AtprotoSession>(fetchImpl, baseUrl, "POST", "com.atproto.server.createSession", {
    body: { identifier, password: credentials.password },
  });
}

export async function putRecord(
  fetchImpl: typeof fetch,
  pdsUrl: string,
  session: AtprotoSession,
  collection: string,
  rkey: string,
  record: unknown
): Promise<{ uri: string; cid: string }> {
  return xrpc(fetchImpl, normalizeBaseUrl(pdsUrl), "POST", "com.atproto.repo.putRecord", {
    token: session.accessJwt,
    body: { repo: session.did, collection, rkey, record },
  });
}

/** Deletes a record; a record that is already gone counts as deleted. */
export async function deleteRecord(
  fetchImpl: typeof fetch,
  pdsUrl: string,
  session: AtprotoSession,
  collection: string,
  rkey: string
): Promise<void> {
  try {
    await xrpc(fetchImpl, normalizeBaseUrl(pdsUrl), "POST", "com.atproto.repo.deleteRecord", {
      token: session.accessJwt,
      body: { repo: session.did, collection, rkey },
    });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

/** Reads one record (no sign-in needed). Returns null when it does not exist. */
export async function fetchRecord<T = Record<string, unknown>>(
  pdsUrl: string,
  repo: string,
  collection: string,
  rkey: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ uri: string; cid?: string; value: T } | null> {
  try {
    return await xrpc(fetchImpl, normalizeBaseUrl(pdsUrl), "GET", "com.atproto.repo.getRecord", {
      params: { repo: repo.trim(), collection, rkey },
    });
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Publishing a persona
// ---------------------------------------------------------------------------

/** Parses at://<repo>/<collection>/<rkey>. */
function parseAtUri(uri: string): { repo: string; collection: string; rkey: string } | null {
  const m = uri.match(/^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/);
  return m ? { repo: m[1], collection: m[2], rkey: m[3] } : null;
}

/** v1 records this tool wrote to the given account, from the v1 import or an M3 publish. */
function legacyRecordsFor(doc: PersonaDocument, did: string): string[] {
  const pubs = doc["creativeid:publications"];
  const uris = new Set<string>();
  const legacyV1 = pubs.legacyV1 as { atproto?: { uri?: string } } | undefined;
  if (legacyV1?.atproto?.uri) uris.add(legacyV1.atproto.uri);
  for (const r of Object.values(pubs.atproto?.records ?? {})) uris.add(r.uri);
  return [...uris].filter((uri) => {
    const parts = parseAtUri(uri);
    return parts?.collection === LEGACY_NSID && parts.repo === did;
  });
}

export async function publishPersona(
  doc: PersonaDocument,
  options: AtprotoPublishOptions
): Promise<AtprotoPublishResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const pdsUrl = normalizeBaseUrl(options.pdsUrl);
  const plan: PublishPlan = planPublish(doc); // validates every record before any network call

  const session = await openAtprotoSession(options, fetchImpl);
  const boundDid = doc["creativeid:publications"].atproto?.did;
  if (boundDid && boundDid !== session.did) throw new AccountMismatchError(boundDid, session.did);
  await options.assertAccount?.(session.did);

  const publishedAt = (options.now ?? new Date()).toISOString();
  const result: AtprotoPublishResult = {
    did: session.did,
    ...(session.handle ? { handle: session.handle } : {}),
    pdsUrl,
    records: { ...(doc["creativeid:publications"].atproto?.records ?? {}) },
    created: [],
    updated: [],
    unchanged: plan.unchanged.map((r) => r.localId),
    deleted: [],
    publishedAt,
  };

  const write = async (r: PlannedRecord, bucket: string[]) => {
    const { uri, cid } = await putRecord(fetchImpl, pdsUrl, session, r.collection, r.rkey, r.record);
    result.records[r.localId] = { uri, cid, rkey: r.rkey, publishedAt };
    bucket.push(r.localId);
  };

  try {
    for (const r of plan.create) await write(r, result.created);
    for (const r of plan.update) await write(r, result.updated);
    for (const d of plan.delete) {
      await deleteRecord(fetchImpl, pdsUrl, session, d.collection, d.rkey);
      delete result.records[d.localId];
      result.deleted.push(d.uri);
    }
    for (const uri of legacyRecordsFor(doc, session.did)) {
      const parts = parseAtUri(uri)!;
      await deleteRecord(fetchImpl, pdsUrl, session, parts.collection, parts.rkey);
      result.deleted.push(uri);
    }
  } catch (err) {
    throw new PublishFailedError(
      `Publishing stopped part-way: ${(err as Error).message}`,
      result
    );
  }
  return result;
}

/** Applies a publish result (complete or partial) to a persona's publication state. */
export function applyAtprotoResult(pubs: PublicationsV2, result: AtprotoPublishResult): PublicationsV2 {
  const next = structuredClone(pubs);
  next.atproto = { did: result.did, pdsUrl: result.pdsUrl, records: result.records };
  const legacyV1 = next.legacyV1 as { atproto?: { uri?: string } } | undefined;
  if (legacyV1?.atproto?.uri && result.deleted.includes(legacyV1.atproto.uri)) {
    delete legacyV1.atproto;
    if (Object.keys(legacyV1).length === 0) delete next.legacyV1;
  }
  return next;
}
