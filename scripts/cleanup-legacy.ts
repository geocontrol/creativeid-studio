/**
 * Removes the v1 Creative Passport record from an ATProto account.
 *
 *   npm run cleanup-legacy -- --pds https://bsky.social --identifier you.bsky.social
 *   npm run cleanup-legacy -- --pds https://bsky.social --identifier you.bsky.social --apply
 *
 * The App Password is read from CREATIVEID_APP_PASSWORD, or asked for.
 * Without --apply it only reports what it would delete.
 */

import { createInterface } from "node:readline/promises";
import { cleanupLegacyRecord } from "../src/atproto/cleanup.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const pdsUrl = arg("pds") ?? "https://bsky.social";
const identifier = arg("identifier");
const apply = process.argv.includes("--apply");
if (!identifier) {
  console.error("Usage: npm run cleanup-legacy -- --pds <url> --identifier <handle or DID> [--apply]");
  process.exit(1);
}

let password = process.env.CREATIVEID_APP_PASSWORD;
if (!password) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  password = (await rl.question(`App Password for ${identifier}: `)).trim();
  rl.close();
}

const result = await cleanupLegacyRecord({ pdsUrl, identifier, password, apply });
if (!result.found) {
  console.log(`Nothing to clean up: ${result.uri} does not exist.`);
} else if (result.deleted) {
  console.log(`Deleted ${result.uri}.`);
} else {
  console.log(`Found ${result.uri}:\n${JSON.stringify(result.record, null, 2)}\nRe-run with --apply to delete it.`);
}
