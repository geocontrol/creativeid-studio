/**
 * Multi-persona local store (`src/library.ts`) — M3.
 *
 * One JSON-LD file per persona under `<root>/<personaId>.jsonld`.
 * - Writes are atomic (temp file + rename) and serialised per persona.
 * - Every file read is checked with validateDocument(); a damaged file is
 *   reported, never silently "fixed" or overwritten.
 * - Deleting moves the file to `<root>/.trash/`; nothing is hard-deleted.
 * - On first run, an old single-persona `data/persona.jsonld` is imported and
 *   kept beside itself as `persona.v1.jsonld.bak`.
 * Pure model logic lives in ./model; this file only does I/O.
 */

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  createPersonaDocument,
  fromV1,
  getConnections,
  getProfile,
  getWorks,
  Issue,
  isPersonaId,
  makePersonaId,
  PersonaDocument,
  ProfileInput,
  PublicationsV2,
  V1PersonaFile,
  validateDocument,
} from "./model/index.js";

export class PersonaNotFound extends Error {
  constructor(public readonly personaId: string) {
    super(`No persona "${personaId}".`);
    this.name = "PersonaNotFound";
  }
}

export class PersonaFileDamaged extends Error {
  constructor(public readonly filePath: string, public readonly issues: Issue[]) {
    super(
      `Persona file ${filePath} is damaged: ` +
        issues.map((i) => `${i.path}: ${i.message}`).join("; ")
    );
    this.name = "PersonaFileDamaged";
  }
}

export interface PersonaSummary {
  personaId: string;
  name: string;
  disciplines: string[];
  works: number;
  connections: number;
  dateCreated: string;
  dateModified: string;
  /** Which targets this persona has been published to. */
  publishedTo: ("atproto" | "solid" | "static")[];
}

export interface MigrationResult {
  personaId: string;
  backupPath: string;
}

const isEnoent = (err: unknown) =>
  !!err && typeof err === "object" && (err as { code?: string }).code === "ENOENT";

export class PersonaLibrary {
  readonly root: string;
  readonly trashDir: string;
  private locks = new Map<string, Promise<unknown>>();

  constructor(root: string) {
    this.root = resolve(root);
    this.trashDir = join(this.root, ".trash");
  }

  /** Absolute path of a persona's file. Throws on ids that could escape the folder. */
  pathFor(personaId: string): string {
    if (!isPersonaId(personaId)) throw new PersonaNotFound(personaId);
    return join(this.root, `${personaId}.jsonld`);
  }

  async list(): Promise<PersonaSummary[]> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (err) {
      if (isEnoent(err)) return [];
      throw err;
    }
    const summaries: PersonaSummary[] = [];
    for (const name of names.filter((n) => n.endsWith(".jsonld")).sort()) {
      const id = name.slice(0, -".jsonld".length);
      if (!isPersonaId(id)) continue;
      const doc = await this.get(id);
      if (doc) summaries.push(summarise(doc));
    }
    return summaries.sort((a, b) => a.dateCreated.localeCompare(b.dateCreated));
  }

  /** The persona, or null if there is no such file. Throws PersonaFileDamaged on a bad file. */
  async get(personaId: string): Promise<PersonaDocument | null> {
    const path = this.pathFor(personaId);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
    let doc: PersonaDocument;
    try {
      doc = JSON.parse(raw) as PersonaDocument;
    } catch (err) {
      throw new PersonaFileDamaged(path, [{ path: "file", message: `Not valid JSON: ${(err as Error).message}` }]);
    }
    const report = validateDocument(doc);
    if (!report.valid) throw new PersonaFileDamaged(path, report.errors);
    if (doc["creativeid:personaId"] !== personaId) {
      throw new PersonaFileDamaged(path, [
        { path: "personaId", message: `File holds persona "${doc["creativeid:personaId"]}".` },
      ]);
    }
    return doc;
  }

  async require(personaId: string): Promise<PersonaDocument> {
    const doc = await this.get(personaId);
    if (!doc) throw new PersonaNotFound(personaId);
    return doc;
  }

  /** Creates and saves a new persona with a fresh, unused id. */
  async create(input: ProfileInput, now: Date = new Date()): Promise<PersonaDocument> {
    let doc = createPersonaDocument(input, { now });
    for (let attempt = 0; await this.exists(doc["creativeid:personaId"]); attempt++) {
      if (attempt > 20) throw new Error("Could not find a free persona id.");
      doc = { ...doc, "creativeid:personaId": makePersonaId(getProfile(doc).name) };
    }
    return this.save(doc);
  }

  /** Validates and atomically writes a persona. */
  async save(doc: PersonaDocument): Promise<PersonaDocument> {
    const path = this.pathFor(doc["creativeid:personaId"]);
    const report = validateDocument(doc);
    if (!report.valid) throw new PersonaFileDamaged(path, report.errors);
    await mkdir(this.root, { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, JSON.stringify(doc, null, 2) + "\n", "utf8");
    await rename(tmp, path);
    return doc;
  }

  /**
   * Read-modify-write under a per-persona lock, so two requests editing the
   * same persona at once cannot lose each other's changes.
   */
  async update(
    personaId: string,
    change: (doc: PersonaDocument) => PersonaDocument | Promise<PersonaDocument>
  ): Promise<PersonaDocument> {
    return this.withLock(personaId, async () => {
      const current = await this.require(personaId);
      const next = await change(current);
      if (next["creativeid:personaId"] !== personaId) {
        throw new Error("A persona's id cannot be changed.");
      }
      return this.save(next);
    });
  }

  /** Moves a persona's file to .trash/ and returns where it went. Never hard-deletes. */
  async delete(personaId: string, now: Date = new Date()): Promise<string> {
    return this.withLock(personaId, async () => {
      const path = this.pathFor(personaId);
      if (!(await this.exists(personaId))) throw new PersonaNotFound(personaId);
      await mkdir(this.trashDir, { recursive: true });
      const stamp = now.toISOString().replace(/[:.]/g, "-");
      const target = join(this.trashDir, `${personaId}.${stamp}.jsonld`);
      await rename(path, target);
      return target;
    });
  }

  async recordPublication(
    personaId: string,
    change: (pubs: PublicationsV2) => PublicationsV2
  ): Promise<PersonaDocument> {
    return this.update(personaId, (doc) => ({
      ...doc,
      "creativeid:publications": change(structuredClone(doc["creativeid:publications"])),
    }));
  }

  /**
   * Imports a v1 single-persona file if this library is still empty.
   * Returns null when there is nothing to import. The v1 file is renamed to
   * `persona.v1.jsonld.bak`, never deleted.
   */
  async migrateV1(v1Path: string, now: Date = new Date()): Promise<MigrationResult | null> {
    let raw: string;
    try {
      raw = await readFile(v1Path, "utf8");
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
    if ((await this.list()).length > 0) return null;
    const v1 = JSON.parse(raw) as V1PersonaFile;
    const doc = fromV1(v1, { now });
    await this.save(doc);
    const backupPath = v1Path.replace(/\.jsonld$/, "") + ".v1.jsonld.bak";
    await rename(v1Path, backupPath);
    return { personaId: doc["creativeid:personaId"], backupPath };
  }

  private async exists(personaId: string): Promise<boolean> {
    try {
      await readFile(this.pathFor(personaId));
      return true;
    } catch (err) {
      if (isEnoent(err)) return false;
      throw err;
    }
  }

  private async withLock<T>(personaId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(personaId) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.catch(() => undefined);
    this.locks.set(personaId, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(personaId) === tail) this.locks.delete(personaId);
    }
  }
}

export function summarise(doc: PersonaDocument): PersonaSummary {
  const profile = getProfile(doc);
  const pubs = doc["creativeid:publications"];
  return {
    personaId: doc["creativeid:personaId"],
    name: profile.name,
    disciplines: profile.knowsAbout ?? [],
    works: getWorks(doc).length,
    connections: getConnections(doc).length,
    dateCreated: profile.dateCreated,
    dateModified: profile.dateModified,
    publishedTo: (["atproto", "solid", "static"] as const).filter((t) => pubs[t]),
  };
}
