/**
 * AT Protocol PDS Adapter (`src/adapters/atproto.ts`)
 * Publishes and reads a CreativeID persona record (`org.creativepassport.actor.persona`)
 * on an AT Protocol Personal Data Server (PDS) via XRPC.
 */

import {
  ATPROTO_COLLECTION_NSID,
  ATPROTO_RECORD_KEY,
  CanonicalPersona,
  PublicationStatus,
} from "../schema.js";
import { AtprotoPersonaRecord, toAtprotoRecord } from "../transformers.js";

export interface AtprotoPublishOptions {
  /** Base URL of the AT Protocol PDS (e.g., "https://bsky.social" or custom PDS) */
  pdsUrl: string;
  /** Handle (e.g. "alice.bsky.social") or DID ("did:plc:...") */
  identifier: string;
  /** App Password (used to create a session if accessJwt is not provided) */
  password?: string;
  /** Existing access JWT (optional if password is provided) */
  accessJwt?: string;
  /** Record key (defaults to "self") */
  rkey?: string;
  /** Optional custom fetch implementation (for testing or custom agent) */
  fetchImpl?: typeof fetch;
  /** Optional timestamp override */
  now?: Date;
}

export interface AtprotoPublishResult {
  status: PublicationStatus;
  did: string;
  record: AtprotoPersonaRecord;
}

interface CreateSessionResponse {
  did: string;
  handle: string;
  accessJwt: string;
}

interface PutRecordResponse {
  uri: string;
  cid: string;
}

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(`Invalid PDS URL "${url}": must start with http:// or https://`);
  }
  return trimmed;
}

/**
 * Creates an authenticated session on an AT Protocol PDS using handle/DID + App Password.
 */
export async function createAtprotoSession(
  pdsUrl: string,
  identifier: string,
  password: string,
  fetchImpl: typeof fetch = fetch
): Promise<CreateSessionResponse> {
  const baseUrl = normalizeBaseUrl(pdsUrl);
  const endpoint = `${baseUrl}/xrpc/com.atproto.server.createSession`;

  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      identifier: identifier.trim(),
      password,
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(
      `ATProto createSession failed (${response.status} ${response.statusText}): ${bodyText}`
    );
  }

  return (await response.json()) as CreateSessionResponse;
}

/**
 * Publishes the canonical persona to an AT Protocol PDS using `com.atproto.repo.putRecord`.
 */
export async function publishToAtproto(
  persona: CanonicalPersona,
  options: AtprotoPublishOptions
): Promise<AtprotoPublishResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = normalizeBaseUrl(options.pdsUrl);
  const identifier = options.identifier.trim();

  if (!identifier) {
    throw new Error("ATProto identifier (handle or DID) is required.");
  }

  let accessJwt = options.accessJwt;
  let repoDid = identifier;

  if (!accessJwt) {
    if (!options.password) {
      throw new Error(
        "Either an App Password (`password`) or an `accessJwt` is required to publish to ATProto."
      );
    }
    const session = await createAtprotoSession(
      baseUrl,
      identifier,
      options.password,
      fetchImpl
    );
    accessJwt = session.accessJwt;
    repoDid = session.did;
  }

  const record = toAtprotoRecord(persona);
  const rkey = options.rkey ?? ATPROTO_RECORD_KEY;
  const putEndpoint = `${baseUrl}/xrpc/com.atproto.repo.putRecord`;

  const response = await fetchImpl(putEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${accessJwt}`,
    },
    body: JSON.stringify({
      repo: repoDid,
      collection: ATPROTO_COLLECTION_NSID,
      rkey,
      record,
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(
      `ATProto putRecord failed (${response.status} ${response.statusText}): ${bodyText}`
    );
  }

  const result = (await response.json()) as PutRecordResponse;
  const publishedAt = (options.now ?? new Date()).toISOString();

  return {
    status: {
      uri: result.uri,
      cid: result.cid,
      publishedAt,
    },
    did: repoDid,
    record,
  };
}

/**
 * Reads a published CreativeID record from an AT Protocol PDS via `com.atproto.repo.getRecord`.
 */
export async function fetchFromAtproto(
  pdsUrl: string,
  repo: string,
  rkey: string = ATPROTO_RECORD_KEY,
  fetchImpl: typeof fetch = fetch
): Promise<{ uri: string; cid?: string; value: AtprotoPersonaRecord }> {
  const baseUrl = normalizeBaseUrl(pdsUrl);
  const params = new URLSearchParams({
    repo: repo.trim(),
    collection: ATPROTO_COLLECTION_NSID,
    rkey,
  });
  const endpoint = `${baseUrl}/xrpc/com.atproto.repo.getRecord?${params.toString()}`;

  const response = await fetchImpl(endpoint, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(
      `ATProto getRecord failed (${response.status} ${response.statusText}): ${bodyText}`
    );
  }

  return (await response.json()) as {
    uri: string;
    cid?: string;
    value: AtprotoPersonaRecord;
  };
}
