/**
 * Solid Pod publisher (`src/adapters/solid.ts`) — M4.
 * PUTs the whole public persona graph (Turtle or JSON-LD) to a Solid resource,
 * and reads resources back.
 */

import { PersonaDocument } from "../model/index.js";
import { baseOf, LinkedDataFormat, serializePersona } from "../rdf.js";

export type SolidDocumentFormat = LinkedDataFormat;

export interface SolidPublishOptions {
  /** Target resource, e.g. "https://alice.solidcommunity.net/public/creativeid.ttl". */
  resourceUrl: string;
  /** Defaults from the URL's extension (.jsonld/.json → JSON-LD, otherwise Turtle). */
  format?: SolidDocumentFormat;
  authToken?: string;
  authScheme?: "Bearer" | "DPoP";
  fetchImpl?: typeof fetch;
  now?: Date;
}

export interface SolidPublishResult {
  status: { uri: string; publishedAt: string };
  resourceUrl: string;
  contentType: "text/turtle" | "application/ld+json";
  content: string;
}

function checkResourceUrl(url: string): string {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(`Invalid Solid resource URL "${url}": must start with http:// or https://`);
  }
  return trimmed;
}

export async function publishToSolid(
  doc: PersonaDocument,
  options: SolidPublishOptions
): Promise<SolidPublishResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resourceUrl = baseOf(checkResourceUrl(options.resourceUrl))!;
  const format: SolidDocumentFormat =
    options.format ?? (/\.(jsonld|json)$/i.test(resourceUrl) ? "jsonld" : "turtle");
  const { contentType, content } = serializePersona(doc, format, resourceUrl);

  const headers: Record<string, string> = { "Content-Type": contentType };
  if (options.authToken?.trim()) {
    headers.Authorization = `${options.authScheme ?? "Bearer"} ${options.authToken.trim()}`;
  }
  const response = await fetchImpl(resourceUrl, { method: "PUT", headers, body: content });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Solid PUT failed (${response.status} ${response.statusText}): ${text}`);
  }
  return {
    status: { uri: `${resourceUrl}#me`, publishedAt: (options.now ?? new Date()).toISOString() },
    resourceUrl,
    contentType,
    content,
  };
}

export async function fetchFromSolid(
  resourceUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ contentType: string; content: string }> {
  const url = baseOf(checkResourceUrl(resourceUrl))!;
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { Accept: "text/turtle, application/ld+json;q=0.9, */*;q=0.1" },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Solid GET failed (${response.status} ${response.statusText}): ${text}`);
  }
  return { contentType: response.headers.get("content-type") ?? "text/plain", content: await response.text() };
}
