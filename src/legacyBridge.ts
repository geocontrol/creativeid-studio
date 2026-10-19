/**
 * TEMPORARY bridge between the v2 persona model and the v1 publishing code
 * (`src/legacyBridge.ts`) — M3 only.
 *
 * The v1 adapters (static, ATProto, Solid) and transformers still publish a
 * single name + bio. Until M4 rewrites them for the persona graph, the server
 * hands them a v1-shaped view built here, and records their results back into
 * the v2 publication state. The `/api/persona` routes used by the current UI
 * also go through this view. Delete this file in M4/M5.
 */

import { CanonicalPersona, CREATIVEID_CONTEXT, PublicationsMap, PublicationStatus } from "./schema.js";
import { getProfile, PersonaDocument, PublicationsV2 } from "./model/index.js";

/** The v1 shape of a v2 persona: profile name and bio only, at #me. */
export function toV1Persona(doc: PersonaDocument): CanonicalPersona {
  const profile = getProfile(doc);
  return {
    "@context": CREATIVEID_CONTEXT,
    "@id": "#me",
    "@type": ["Person", "creativeid:Persona"],
    name: profile.name,
    description: profile.description ?? "",
    dateCreated: profile.dateCreated,
    dateModified: profile.dateModified,
    "creativeid:publications": toV1Publications(doc["creativeid:publications"]),
  };
}

/** v2 publication state flattened to the v1 map the current UI renders. */
export function toV1Publications(pubs: PublicationsV2): PublicationsMap {
  const out: PublicationsMap = {};
  const me = pubs.atproto?.records?.me;
  if (me) out.atproto = { uri: me.uri, ...(me.cid ? { cid: me.cid } : {}), publishedAt: me.publishedAt };
  if (pubs.solid) out.solid = { ...pubs.solid };
  if (pubs.static) out.static = { ...pubs.static };
  return out;
}

/** Records a v1 adapter's result in v2 publication state. */
export function withV1Publication(
  pubs: PublicationsV2,
  target: "atproto" | "solid" | "static",
  status: PublicationStatus,
  atproto?: { did?: string; pdsUrl?: string }
): PublicationsV2 {
  const next = structuredClone(pubs);
  if (target === "atproto") {
    const rkey = status.uri.split("/").pop() || "self";
    next.atproto = {
      ...next.atproto,
      ...(atproto?.did ? { did: atproto.did } : {}),
      ...(atproto?.pdsUrl ? { pdsUrl: atproto.pdsUrl } : {}),
      records: {
        ...(next.atproto?.records ?? {}),
        me: { uri: status.uri, ...(status.cid ? { cid: status.cid } : {}), rkey, publishedAt: status.publishedAt },
      },
    };
  } else {
    next[target] = { uri: status.uri, publishedAt: status.publishedAt };
  }
  return next;
}
