/**
 * Local-First File Persistence Engine (`src/store.ts`)
 * Manages reading, creating, updating, and recording publications for the local
 * canonical persona (`data/persona.jsonld`).
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  CanonicalPersona,
  createCanonicalPersona,
  PersonaInput,
  PublicationsMap,
  PublicationStatus,
  updateCanonicalPersona,
  validatePersonaInput,
} from "./schema.js";

export class PersonaStore {
  public readonly filePath: string;

  constructor(filePath: string = resolve(process.cwd(), "data/persona.jsonld")) {
    this.filePath = filePath;
  }

  /**
   * Loads the canonical persona from disk, or returns `null` if none exists yet.
   */
  async load(): Promise<CanonicalPersona | null> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as CanonicalPersona;
      return parsed;
    } catch (err: unknown) {
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code?: string }).code === "ENOENT"
      ) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Atomically writes the canonical persona to disk (via temp file + rename).
   */
  async save(persona: CanonicalPersona): Promise<CanonicalPersona> {
    const validation = validatePersonaInput({
      name: persona.name,
      biography: persona.description,
      id: persona["@id"],
    });
    if (!validation.valid) {
      const msg = validation.issues.map((i) => `${i.field}: ${i.message}`).join("; ");
      throw new Error(`Cannot save invalid persona: ${msg}`);
    }

    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });

    const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    const serialized = JSON.stringify(persona, null, 2) + "\n";
    await writeFile(tmpPath, serialized, "utf8");
    await rename(tmpPath, this.filePath);

    return persona;
  }

  /**
   * Creates or updates the local persona and saves it to disk.
   */
  async upsert(input: PersonaInput, now: Date = new Date()): Promise<CanonicalPersona> {
    const existing = await this.load();
    const next = existing
      ? updateCanonicalPersona(existing, input, now)
      : createCanonicalPersona(input, now);

    return this.save(next);
  }

  /**
   * Records a successful publication to a target protocol (`atproto`, `solid`, or `static`).
   */
  async recordPublication(
    target: keyof PublicationsMap,
    status: PublicationStatus
  ): Promise<CanonicalPersona> {
    const existing = await this.load();
    if (!existing) {
      throw new Error("Cannot record publication: no local persona exists yet.");
    }

    const updated: CanonicalPersona = {
      ...existing,
      "cp:publications": {
        ...(existing["cp:publications"] ?? {}),
        [target]: status,
      },
    };

    return this.save(updated);
  }
}
