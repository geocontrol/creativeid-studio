/**
 * Copies the CultureBlocs lexicons this studio publishes into ./lexicons.
 *
 *   npm run vendor-lexicons [-- <path to cultureblocs-string/lexicons>]
 *
 * cultureblocs.com is the schema authority for com.cultureblocs.*; these are
 * read-only copies used to validate records before they leave the machine.
 * Never edit them here: change them in cultureblocs-string and re-run this.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FILES = [
  "com/cultureblocs/defs.json",
  "com/cultureblocs/creative/profile.json",
  "com/cultureblocs/creative/work.json",
  "com/cultureblocs/creative/connection.json",
];

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
  process.argv[2],
  process.env.CULTUREBLOCS_LEXICONS,
  join(root, "..", "cultureblocs-string", "lexicons"),
  join(root, "..", "..", "cultureblocs-string", "lexicons"),
].filter((p): p is string => !!p);

const source = candidates.map((p) => resolve(p)).find((p) => existsSync(join(p, FILES[0])));
if (!source) {
  console.error(`Could not find the CultureBlocs lexicons. Tried:\n  ${candidates.join("\n  ")}`);
  process.exit(1);
}

let commit = "unknown";
try {
  commit = execFileSync("git", ["-C", source, "log", "-1", "--format=%h %cs", "--", ...FILES], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  /* not a git checkout */
}

for (const file of FILES) {
  const target = join(root, "lexicons", file);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(join(source, file), target);
  console.log(`copied ${file}`);
}

await writeFile(
  join(root, "lexicons", "README.md"),
  `# Vendored lexicons — do not edit

Read-only copies of the CultureBlocs lexicons this studio publishes. The
schema authority for \`com.cultureblocs.*\` is cultureblocs.com
(https://www.cultureblocs.com/lexicons.html); the source of truth is the
\`cultureblocs-string\` repository.

- Copied from: \`cultureblocs-string/lexicons\`
- Source commit: ${commit}
- Files: ${FILES.map((f) => `\`${f}\``).join(", ")}

Every record the studio sends to an ATProto PDS is validated against these
first. To update: change the lexicons in cultureblocs-string, then run
\`npm run vendor-lexicons\`.
`,
  "utf8"
);
console.log(`lexicons vendored from ${source} (${commit})`);
