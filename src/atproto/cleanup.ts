/**
 * Finds and (optionally) deletes the v1 Creative Passport record,
 * `org.creativepassport.actor.persona/self`, from an ATProto account
 * (`src/atproto/cleanup.ts`) — M4. Publishing a persona already removes the
 * v1 record from its own account; this is for accounts published to some
 * other way. Dry run by default.
 */

import { AtprotoCredentials, deleteRecord, fetchRecord, normalizeBaseUrl, openAtprotoSession } from "../adapters/atproto.js";
import { LEGACY_NSID } from "./records.js";

export interface CleanupOptions extends AtprotoCredentials {
  /** Actually delete. Without it, only report. */
  apply?: boolean;
  fetchImpl?: typeof fetch;
}

export interface CleanupResult {
  did: string;
  uri: string;
  found: boolean;
  deleted: boolean;
  record?: unknown;
}

export async function cleanupLegacyRecord(options: CleanupOptions): Promise<CleanupResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const pdsUrl = normalizeBaseUrl(options.pdsUrl);
  const session = await openAtprotoSession(options, fetchImpl);
  const uri = `at://${session.did}/${LEGACY_NSID}/self`;
  const existing = await fetchRecord(pdsUrl, session.did, LEGACY_NSID, "self", fetchImpl);
  if (!existing) return { did: session.did, uri, found: false, deleted: false };
  if (options.apply) await deleteRecord(fetchImpl, pdsUrl, session, LEGACY_NSID, "self");
  return { did: session.did, uri, found: true, deleted: !!options.apply, record: existing.value };
}
