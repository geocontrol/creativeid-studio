/**
 * Static file publisher (`src/adapters/static.ts`) — M4.
 * Writes the whole public persona graph as JSON-LD or Turtle, for hosting on
 * a personal domain (ideally at /.well-known/creativeid.jsonld), GitHub
 * Pages, S3 or IPFS.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { PersonaDocument } from "../model/index.js";
import { baseOf, LinkedDataFormat, serializePersona } from "../rdf.js";

export type StaticExportFormat = LinkedDataFormat;

/** Where a static persona file is best hosted, so the aggregator can find it from a bare domain. */
export const WELL_KNOWN_PATH = "/.well-known/creativeid.jsonld";

export interface StaticExportOptions {
  /** File to write. */
  outputPath: string;
  format?: StaticExportFormat;
  /** Where the file will be hosted; written as the document base. */
  publicUrl?: string;
  now?: Date;
}

export interface StaticExportResult {
  status: { uri: string; publishedAt: string };
  outputPath: string;
  contentType: "application/ld+json" | "text/turtle";
  content: string;
}

export async function publishStaticExport(
  doc: PersonaDocument,
  options: StaticExportOptions
): Promise<StaticExportResult> {
  const format = options.format ?? "jsonld";
  const outputPath = resolve(options.outputPath);
  const { contentType, content } = serializePersona(doc, format, options.publicUrl);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content, "utf8");
  const base = baseOf(options.publicUrl) ?? pathToFileURL(outputPath).href;
  return {
    status: { uri: `${base}#me`, publishedAt: (options.now ?? new Date()).toISOString() },
    outputPath,
    contentType,
    content,
  };
}
