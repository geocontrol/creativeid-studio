/**
 * Solid Pod Adapter (`src/adapters/solid.ts`)
 * Publishes and reads a Creative Passport persona document on a Solid Pod
 * via HTTP PUT / GET (supporting both `text/turtle` and `application/ld+json`).
 */

import { CanonicalPersona, PublicationStatus } from "../schema.js";
import { toPublicJsonLd, toSolidTurtle } from "../transformers.js";

export type SolidDocumentFormat = "turtle" | "jsonld";

export interface SolidPublishOptions {
  /** Target Solid resource URL (e.g. "https://alice.solidcommunity.net/public/passport.ttl") */
  resourceUrl: string;
  /** Serialization format: "turtle" (default for Solid) or "jsonld" */
  format?: SolidDocumentFormat;
  /** Optional Bearer / Solid access token if writing to a protected container */
  authToken?: string;
  /** Optional Authorization header scheme (defaults to "Bearer") */
  authScheme?: "Bearer" | "DPoP";
  /** Optional custom fetch implementation (e.g. from @inrupt/solid-client-authn-node or tests) */
  fetchImpl?: typeof fetch;
  /** Optional timestamp override */
  now?: Date;
}

export interface SolidPublishResult {
  status: PublicationStatus;
  resourceUrl: string;
  contentType: "text/turtle" | "application/ld+json";
  content: string;
}

function validateResourceUrl(url: string): string {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(
      `Invalid Solid resource URL "${url}": must start with http:// or https://`
    );
  }
  return trimmed;
}

/**
 * Publishes a CanonicalPersona to a Solid Pod resource URL via HTTP PUT.
 */
export async function publishToSolid(
  persona: CanonicalPersona,
  options: SolidPublishOptions
): Promise<SolidPublishResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resourceUrl = validateResourceUrl(options.resourceUrl);
  const format: SolidDocumentFormat =
    options.format ??
    (resourceUrl.endsWith(".jsonld") || resourceUrl.endsWith(".json")
      ? "jsonld"
      : "turtle");

  const baseResourceUrl = resourceUrl.split("#")[0];
  const subjectUri = resourceUrl.includes("#")
    ? resourceUrl
    : `${baseResourceUrl}#me`;

  const contentType =
    format === "turtle" ? "text/turtle" : "application/ld+json";
  const content =
    format === "turtle"
      ? toSolidTurtle(persona, subjectUri)
      : JSON.stringify(toPublicJsonLd(persona, subjectUri), null, 2) + "\n";

  const headers: Record<string, string> = {
    "Content-Type": contentType,
  };

  if (options.authToken?.trim()) {
    const scheme = options.authScheme ?? "Bearer";
    headers["Authorization"] = `${scheme} ${options.authToken.trim()}`;
  }

  const response = await fetchImpl(baseResourceUrl, {
    method: "PUT",
    headers,
    body: content,
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(
      `Solid PUT failed (${response.status} ${response.statusText}): ${bodyText}`
    );
  }

  const publishedAt = (options.now ?? new Date()).toISOString();

  return {
    status: {
      uri: subjectUri,
      publishedAt,
    },
    resourceUrl: baseResourceUrl,
    contentType,
    content,
  };
}

/**
 * Reads a published Creative Passport resource from a Solid Pod via HTTP GET.
 */
export async function fetchFromSolid(
  resourceUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ contentType: string; content: string }> {
  const cleanUrl = validateResourceUrl(resourceUrl).split("#")[0];

  const response = await fetchImpl(cleanUrl, {
    method: "GET",
    headers: {
      Accept: "text/turtle, application/ld+json;q=0.9, */*;q=0.1",
    },
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(
      `Solid GET failed (${response.status} ${response.statusText}): ${bodyText}`
    );
  }

  const contentType = response.headers.get("content-type") ?? "text/plain";
  const content = await response.text();
  return { contentType, content };
}
