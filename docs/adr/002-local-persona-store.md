# ADR 002: The local persona store

- **Status:** Accepted, 2026-10-19 (implemented in M2 `e6a4209`, M3 `2e3ea0d` and M4 `b8bd8e4`)
- **Decides:** plan decisions D4 and D6; open questions 3 and 4 in the roadmap

## Context

The studio is local-first: the copy on the creative's computer is the real one, and everything published is a copy of its public parts. M2–M4 had to decide four things: where that copy lives, what shape it takes, how personas relate to publishing accounts, and how private details stay private.

The options for where the copy lives were:

- **A.** One JSON-LD file per persona, inside the studio's `data/` folder.
- **B.** Records in the CultureBlocs String (FastAPI + SQLite), which already handles several identities and publishing.

## Decision

1. **One JSON-LD file per persona** (`data/personas/<personaId>.jsonld`). This is option A.
   - The file is a graph: the profile at `#me`, works at `#work-<tid>`, connections at `#claim-<tid>`.
   - schema.org terms are used where they fit; `creativeid:` terms are used otherwise ([ADR 001](001-creativeid-naming-and-namespace.md)).
   - Writes are atomic (temp file + rename) and serialised per persona.
   - Every read is validated, and a damaged file is reported, never overwritten.
   - Deleting moves the file to `data/personas/.trash/`.
2. **Field limits are the lexicons' limits.** Anything valid locally can always be published. Only the name is required; nothing blocks saving for being incomplete.
3. **Every work and connection gets a TID when it's created,** and that TID becomes its AT Protocol record key. Republishing updates records in place.
4. **Private details live in `creativeid:private`** inside the same file. `toPublicDocument()` is the only way to anything public: every publisher and preview starts from it, and tests check that private values never reach any output.
5. **One persona = one account.**
   - A persona remembers the DID it first published to, and refuses to publish to another.
   - The studio also refuses to publish a second persona to a DID that one already uses.
   - Personas are never linked to each other in anything published.
6. **App Passwords are used for one publish and never stored** (D6). Keychain storage is a later option.
7. **Studio-wide settings** (for now, directories to tell on publish) live in `data/settings.json`, beside the personas folder.

## Why

- **Files over a database.** A persona is small, rarely edited, and benefits from being a plain file the creative can read, back up, sync, diff or move. A JSON-LD file is already Linked Data, so the static and Solid outputs are views of it, not translations. The String is a better home for high-volume diary records (beads), and the two can meet later through an export, not a shared database.
- **Lexicon-shaped limits** mean a creative never finds out at publish time that something they saved can't go out.
- **TIDs as rkeys** make publishing idempotent without a mapping table, and they sort by creation time.
- **One persona per account** protects pseudonymous and at-risk creatives. A stage persona and a legal-name persona must not be linkable by accident, and an AT Protocol account can hold only one profile record anyway.
- **A single route to public output** turns "never leaks" into one function to review and test, instead of a rule every publisher has to remember.

## Consequences

- There's no sync between devices beyond what the person does with the files (iCloud, git, Syncthing). Two devices editing the same persona at once can conflict, and that isn't handled.
- No String integration yet. If CultureBlocs tools want persona data, they read what was published (the directory, or AT Protocol), or a future export.
- Changing the shape of the file needs a `creativeid:schemaVersion` bump and a migration step, as the v1 → v2 import does.
- A persona's DID binding can only be undone by editing its file. That's deliberate for now, because it's rare and risky.
