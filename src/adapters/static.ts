/**
 * Static File Export Adapter (`src/adapters/static.ts`)
 * Exports a CanonicalPersona as a standalone JSON-LD or RDF Turtle file
 * suitable for hosting on a personal domain, GitHub Pages, S3, or IPFS.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CanonicalPersona, PublicationStatus } from "../schema.js";
import { toPublicJsonLd, toSolidTurtle } from "../transformers.js";

export type StaticExportFormat = "jsonld" | "turtle";

export interface StaticExportOptions {
  /** Target file path on disk (e.g. ./exports/passport.jsonld) */
  outputPath: string;
  /** Serialization format: "jsonld" (default) or "turtle" */
  format?: StaticExportFormat;
  /** Optional public URL where this file will be hosted (used as @id / subject URI) */
  publicUrl?: string;
  /** Optional timestamp override */
  now?: Date;
}

export interface StaticExportResult {
  status: PublicationStatus;
  outputPath: string;
  contentType: "application/ld+json" | "text/turtle";
  content: string;
}

export function serializeStaticExport(
  persona: CanonicalPersona,
  format: StaticExportFormat = "jsonld",
  publicUrl?: string
): { contentType: "application/ld+json" | "text/turtle"; content: string } {
  if (format === "turtle") {
    return {
      contentType: "text/turtle",
      content: toSolidTurtle(persona, publicUrl),
    };
  }

  const doc = toPublicJsonLd(persona, publicUrl);
  return {
    contentType: "application/ld+json",
    content: JSON.stringify(doc, null, 2) + "\n",
  };
}

export async function publishStaticExport(
  persona: CanonicalPersona,
  options: StaticExportOptions
): Promise<StaticExportResult> {
  const format = options.format ?? "jsonld";
  const resolvedPath = resolve(options.outputPath);
  const { contentType, content } = serializeStaticExport(
    persona,
    format,
    options.publicUrl
  );

  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, content, "utf8");

  const publishedAt = (options.now ?? new Date()).toISOString();
  const uri = options.publicUrl?.trim() || pathToFileURL(resolvedPath).href;

  return {
    status: {
      uri,
      publishedAt,
    },
    outputPath: resolvedPath,
    contentType,
    content,
  };
}
