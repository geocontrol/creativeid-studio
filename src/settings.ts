/**
 * Studio settings (`src/settings.ts`) — M6.
 *
 * Settings for the whole studio, not one persona, kept in data/settings.json.
 * For now: the directories (CreativeID aggregators) to tell after a publish.
 * Empty by default: publishing tells nobody unless you choose to.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface StudioSettings {
  /** Aggregator base URLs, e.g. "http://localhost:3500" or "https://index.example". */
  indexes: string[];
}

export const MAX_INDEXES = 5;

export class SettingsStore {
  constructor(readonly filePath: string) {}

  async get(): Promise<StudioSettings> {
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<StudioSettings>;
      return { indexes: Array.isArray(raw.indexes) ? raw.indexes.filter((x) => typeof x === "string") : [] };
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return { indexes: [] };
      throw err;
    }
  }

  async set(input: Partial<StudioSettings>): Promise<StudioSettings> {
    const indexes = [...new Set((input.indexes ?? []).map((u) => String(u).trim().replace(/\/+$/, "")).filter(Boolean))];
    const bad = indexes.filter((u) => !/^https?:\/\/[^\s/]+/i.test(u));
    if (bad.length) throw new Error(`Not a web address: ${bad.join(", ")}`);
    if (indexes.length > MAX_INDEXES) throw new Error(`At most ${MAX_INDEXES} directories.`);
    const settings = { indexes };
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, JSON.stringify(settings, null, 2) + "\n", "utf8");
    await rename(tmp, this.filePath);
    return settings;
  }
}

export interface IndexNotice {
  index: string;
  ok: boolean;
  error?: string;
}

/**
 * Tells each directory where to find the persona (POST /v1/index). Failures
 * are reported, never fatal: the publish itself has already succeeded.
 */
export async function notifyIndexes(
  indexes: string[],
  body: { uri: string; pdsUrl?: string; handle?: string; sourceType?: string },
  fetchImpl: typeof fetch = fetch
): Promise<IndexNotice[]> {
  return Promise.all(
    indexes.map(async (index): Promise<IndexNotice> => {
      try {
        const res = await fetchImpl(`${index}/v1/index`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) return { index, ok: true };
        const text = await res.text().catch(() => "");
        let message = text;
        try {
          message = (JSON.parse(text) as { error?: string }).error ?? text;
        } catch {
          /* plain text */
        }
        return { index, ok: false, error: `${res.status}: ${message}`.slice(0, 300) };
      } catch (err) {
        return { index, ok: false, error: (err as Error).message };
      }
    })
  );
}
