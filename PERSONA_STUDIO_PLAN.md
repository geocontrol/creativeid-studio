# Plan: CreativePassport → CreativeID Persona Studio

Status: M0–M6 done · 2026-10-20
Covers both repos: `CreativePassport` (→ studio) and `CreativePassportAggregator` (→ aggregator).
Context: roadmap phases 1–3 in the doc *Creative Persona × CultureBlocs — Roadmap Vision*.

## Outcome

When this plan is done:

- **CreativeID Studio** is a local-first app (still `localhost:3400`). It holds **several personas**, each with a profile, works and connections. It runs fully offline and needs no account.
- Publishing writes the existing CultureBlocs lexicons: `com.cultureblocs.creative.profile`, `.work` and `.connection`. The `org.creativepassport.*` lexicon is gone.
- Static `/.well-known/creativeid.jsonld` and Solid publishing keep working, now with the full persona graph.
- **CreativeID Aggregator** (still `localhost:3500`) indexes all three record types and can be searched by discipline as well as by name. It reports closed loops as facts, not badges.
- Nothing anywhere says "Creative Passport".

## Decisions this plan assumes (confirm or change before M1)

| # | Decision | Assumed choice | Alternative |
|---|---|---|---|
| D1 | Repo names | `creativeid-studio`, `creativeid-aggregator` (matching the `cultureblocs-*` names) | `CreativeID`, `CreativeIDAggregator` |
| D2 | Display names | "CreativeID Studio", "CreativeID Aggregator" | "CreativeID Index" for the aggregator |
| D3 | JSON-LD vocabulary for our own terms | prefix `creativeid:` → `https://www.cultureblocs.com/ns/creativeid#` | `cb:` → `https://www.cultureblocs.com/ns#` |
| D4 | Local copy | JSON-LD files, one per persona (roadmap open question 3, option A); String sync later | Store records in the String |
| D5 | Aggregator API nouns | `/v1/personas` replaces `/v1/artists` ("artist" excludes curators, performers and others) | Keep `/v1/artists` as an alias |
| D6 | Credentials | App passwords are entered for each publish and never written to disk, as now | macOS Keychain later |
| D7 | Legacy names | No compatibility shims: the prototype is days old. A cleanup script removes any test records already published | Read old names for one release |

Prefix note for D3: don't use `cid:` as the prefix. It would be confused with content IDs (CIDs), which the aggregator already stores.

---

## M0 · Prepare (½ day)

1. Commit or stash the WIP: `public/wizard.js`, `public/wizard.css` and the change to `public/index.html`.
2. Tag the current state in both repos as `v0.1.0-creative-passport`.
3. **Find published records.** For every PDS account used in testing, run `com.atproto.repo.listRecords?collection=org.creativepassport.actor.persona`. Note any Solid or static URLs that hold `passport.ttl`/`.jsonld`. This sets the scope of `scripts/cleanup-legacy.ts` in M4.
4. Create branch `persona-studio` in both repos.

**Exit:** clean trees, tags pushed, a list of legacy records (possibly empty).

---

## M1 · Rename to CreativeID (mechanical: no behaviour change)

Rename only. All existing tests must still pass at the end. Behaviour changes come in M2 onwards, so a reviewer can trust this diff with a quick read.

### Rename map

| Old | New | Where |
|---|---|---|
| repo `CreativePassport` | `creativeid-studio` | GitHub (old URLs redirect), `git remote set-url`, local folder `TPM/CreativePassport/CreativePassport` |
| repo `CreativePassportAggregator` | `creativeid-aggregator` | as above |
| parent folder `TPM/CreativePassport` | `TPM/CreativeID` | reconnect the folder in the desktop app afterwards |
| `"name": "creative-passport"` | `"creativeid-studio"` | `package.json`; regenerate `package-lock.json` |
| `"creative-passport-aggregator"` | `"creativeid-aggregator"` | aggregator `package.json` + lock |
| keyword `creative-passport` | `creativeid` | both `package.json` |
| "Creative Passport" (display) | "CreativeID Studio" / "CreativeID" | `public/index.html`, `public/wizard.js`, `src/server.ts`, `src/index.ts` log line, adapter comments, aggregator `public/index.html`, `src/server.ts`, `src/index.ts`, `src/types.ts` header |
| `createPassportServer` | `createStudioServer` | `src/server.ts`, `src/index.ts`, tests |
| `CREATIVE_PASSPORT_CONTEXT` | `CREATIVEID_CONTEXT` | `schema.ts`, `transformers.ts` |
| `cp:` → `https://creativepassport.org/ns#` | `creativeid:` → D3 namespace | studio `schema.ts`, `transformers.ts` (Turtle prefix too); aggregator `types.ts`, `resolver.ts`, tests |
| `cp:CreativePersona` | `creativeid:Persona` | both repos |
| `cp:publications` | `creativeid:publications` | `schema.ts`, `store.ts`, tests |
| `cp:sourceProtocol`, `cp:sourceUri`, `cp:did`, `cp:cid` | `creativeid:sourceProtocol`, … | aggregator `types.ts`, `resolver.ts`, tests |
| `cp_` id prefix | `pers_` (not `cid_`, see D3 note) | aggregator `resolver.ts#makeArtistId` |
| `/.well-known/creative-passport.jsonld` | `/.well-known/creativeid.jsonld` | studio static adapter + `wizard.js` copy; aggregator `resolver.ts`, `indexer.ts` seeds, tests |
| `passport.jsonld` / `passport.ttl` default filenames | `creativeid.jsonld` / `creativeid.ttl` | static & Solid adapters, sandbox paths, UI hints, briefing docs |
| `localStorage` key `cp.storageGuide.v1` | `creativeid.storageGuide.v1` | `public/wizard.js` |
| `test/milestone{1,2,3}.test.ts` | keep names; update fixtures | — |
| Docs | Rewrite name references | `README.md`, `SCOPE.md`, `BRIEFING_ATPROTO_AND_SOLID.md`, `AGGREGATOR_ARCHITECTURE.md`, aggregator `README.md`, `SCOPE.md` |

`org.creativepassport.actor.persona` is **not** renamed here. It is replaced in M4. Renaming it to another custom NSID would create a third persona schema.

### Check

```bash
grep -rniI --exclude-dir={node_modules,.git,dist} -e 'creative.\?passport' -e '"cp:' -e 'cp\.' .
```
The only matches allowed are the `org.creativepassport` NSID strings, which M4 removes.

**Exit:** grep clean (apart from the NSID), `npm test` green in both repos, both UIs load with the new names.

---

## M2 · Canonical model v2: persona graph

Replace the single `Person` (name + bio) with a small JSON-LD graph per persona. Field limits mirror the CultureBlocs lexicons exactly, so anything valid locally can always be published.

### Local document: `data/personas/<personaId>.jsonld`

As built (`src/model/`). Profile and work properties use schema.org terms where one fits (`identifier` as `PropertyValue`, `homeLocation` as `Place`); everything else is a `creativeid:` term.

```json
{
  "@context": { "@vocab": "https://schema.org/",
                "foaf": "http://xmlns.com/foaf/0.1/",
                "creativeid": "https://www.cultureblocs.com/ns/creativeid#" },
  "creativeid:schemaVersion": 2,
  "creativeid:personaId": "laurie-spiegel-ab2c",
  "@graph": [
    { "@id": "#me", "@type": ["Person", "creativeid:Persona"],
      "name": "…", "description": "…",
      "knowsAbout": ["sculpture", "sound design"],
      "homeLocation": { "@type": "Place", "name": "Peckham, London" },
      "creativeid:links": [{ "@type": "WebPage", "url": "https://…", "name": "Website" }],
      "identifier": [{ "@type": "PropertyValue", "propertyID": "orcid", "value": "0000-…" }],
      "dateCreated": "…", "dateModified": "…" },
    { "@id": "#work-3l4k2jxyz2222", "@type": ["CreativeWork", "creativeid:Work"],
      "name": "Untitled (Peckham)", "url": "https://…",
      "creativeid:completionDate": "Spring 2024", "description": "…",
      "creativeid:credits": [{ "@type": "creativeid:Credit", "name": "…",
                               "creativeid:did": "did:plc:…", "creativeid:role": "lighting design" }],
      "keywords": ["…"], "dateCreated": "…", "dateModified": "…" },
    { "@id": "#claim-3l4k3a2222222", "@type": "creativeid:Connection",
      "creativeid:subject": { "creativeid:did": "did:plc:…" },
      "creativeid:relationship": "performed", "creativeid:role": "…", "creativeid:note": "…",
      "dateCreated": "…", "dateModified": "…" }
  ],
  "creativeid:private": { "legalName": "…", "bookingContact": "…" },
  "creativeid:publications": { "atproto": { "did": "…", "records": { "<localId>": { "uri": "…", "cid": "…", "rkey": "…" } } } }
}
```

The API and UI never see these key names: every node has a plain *input* shape (`ProfileInput`, `WorkInput`, `ConnectionInput`, with lexicon-style names such as `bio`, `disciplines`, `externalIds`) and the model converts both ways.

### Rules

- **Identity of things.** Each work and connection gets a TID (ATProto timestamp ID) as its local id when it is created. The same TID is used as its ATProto `rkey`, so republishing updates the record in place, never duplicates it. The profile always uses `rkey: self`.
- **Limits, from the lexicons:**
  - profile: name ≤ 300 graphemes, bio ≤ 2,000, disciplines ≤ 8 × 64, links ≤ 8, externalIds ≤ 20
  - work: title ≤ 300, completionDate ≤ 100 (free text, not a datetime), description ≤ 2,000, credits ≤ 20, tags ≤ 8 × 64, links ≤ 8, externalIds ≤ 20
  - connection: relationship ≤ 64 (advisory values from the lexicon, plus `curated`), role ≤ 100, note ≤ 500
- **Only `name` is required.** The bio stops being required (v1 required it). No checks may block saving. Validation can warn; it only refuses data that cannot be stored or published at all (it breaks a limit).
- **Private block.** `creativeid:private` holds anything the wizard marks "Only me" or "Shared". Transformers never read it, and a unit test checks this. Tier-4 material belongs here in future.
- **Publication state** (`creativeid:publications`) is local-only and stripped from every output, as `cp:publications` is today.

### Code (done 2026-10-19)

- `src/model/limits.ts`: lexicon limits, known relationships and ID schemes.
- `src/model/tid.ts`: TID generator (microseconds + 10-bit clock id, base32-sortable, monotonic).
- `src/model/types.ts`: node and input types, `PersonaDocument`, `PublicPersonaDocument`, `Issue` (path-based, e.g. `works[2].title`), `ValidationReport` (errors block, warnings don't).
- `src/model/persona.ts`: `createPersonaDocument`, `updateProfile`, `addWork` / `updateWork` / `removeWork`, `addConnection` / `updateConnection` / `removeConnection`, `setPrivateField`, `validateDocument` (for files read from disk), `toPublicDocument` (the only route to anything public), `fromV1` (v1 import, old publication state kept under `legacyV1`), `makePersonaId`. All pure; updates replace every editable field (PUT semantics).
- `src/schema.ts` (v1) stays until M3 moves the store and server over, then is deleted.
- `npm run typecheck` now type-checks the tests too.

**Exit:** unit tests cover each limit, the TID's ordering and format, and that the private block never leaks. ✅ `test/m2-model.test.ts`, 26 tests.

---

## M3 · Multi-persona store and API

- `src/store.ts` → `PersonaStore` over the folder `data/personas/`. Methods: `list()`, `load(id)`, `create(input)`, `save(doc)` (keep the atomic temp-file + rename), `delete(id)` (move to `data/personas/.trash/`, never hard-delete), `recordPublication(id, target, localId, status)`.
- **Migration:** on start, if `data/persona.jsonld` exists and `data/personas/` doesn't, convert it into the first persona. Keep the old file as `persona.v1.jsonld.bak`.
- `personaId` is a slug of the name plus a short random suffix. It is never derived from a DID, because a persona exists before it is published.
- **Routes** (replacing `/api/persona`):

| Method | Path |
|---|---|
| GET / POST | `/api/personas` |
| GET / PUT / DELETE | `/api/personas/:id` |
| POST | `/api/personas/:id/works` · PUT/DELETE `/api/personas/:id/works/:workId` |
| POST | `/api/personas/:id/connections` · PUT/DELETE `…/connections/:connId` |
| GET | `/api/personas/:id/preview?format=jsonld\|turtle\|atproto` |
| GET | `/api/personas/:id/export/download?format=jsonld\|ttl` |
| POST | `/api/personas/:id/publish/{static,atproto,solid}` |

- The server still binds to `127.0.0.1` only.

**Exit:** API tests cover CRUD for all three record types, the migration from a v1 file, and a delete going to `.trash`. The studio keeps working with the network disabled (test: stub `fetch` to throw; every non-publish route still passes). ✅ `test/m3-library-api.test.ts`, 20 tests.

### As built (done 2026-10-19)

- **`src/library.ts` · `PersonaLibrary`** (new file, not a rewrite of `store.ts`): `list()`, `get(id)`, `require(id)`, `create(input)`, `save(doc)`, `update(id, change)`, `delete(id)`, `recordPublication(id, change)`, `migrateV1(path)`. Writes are atomic and **serialised per persona** (a lock), so two edits at once can't lose each other. Every file read is checked with `validateDocument()`; a damaged file returns **422** and is never overwritten. Ids are checked before touching the disk, so `../` paths can't escape the folder.
- **Migration** runs once at start-up, before the first request is served. It only imports when the library is empty and renames the old file to `persona.v1.jsonld.bak`.
- **`src/api.ts`**: the routes above, plus `PUT /api/personas/:id/private` (`{ key, value }`). Errors: 400 with field paths (`profile.links[0].uri`), 404 for unknown personas, works or connections, 413 for oversized bodies, 422 for damaged files. Exports go to `data/exports/<personaId>/`.
- **The current UI keeps working.** `GET/PUT /api/persona`, `/api/export/download` and `/api/publish/*` still exist and act on the first persona. A save from the old form changes only the name and bio and keeps every other field. These routes go in M5.
- **Publishing still uses the v1 publishers** (name + bio, `org.creativepassport.actor.persona`) through `src/legacyBridge.ts`, which records results in the v2 publication state. `GET …/preview` already returns `publicGraph` (the v2 graph M4 will publish) beside the v1 outputs. **M4 deletes `legacyBridge.ts`, `schema.ts`, `store.ts` and `transformers.ts`'s v1 functions** (they were due to go in M3, but the v1 publishers still need them).
- **Deferred to M4:** the one-persona-one-account check. Before a session it isn't possible to know which DID a handle belongs to, so the check belongs in the rewritten ATProto adapter.

---

## M4 · Publish to CultureBlocs lexicons

### ATProto

- **Vendor, don't author.** Add `scripts/vendor-lexicons.ts`, which copies `com/cultureblocs/{defs.json,creative/*.json}` from `../cultureblocs-string/lexicons` (or fetches from cultureblocs.com). Put them in `lexicons/com/cultureblocs/` with a header noting their source. Delete `lexicons/org/creativepassport/`.
- **Validate before publishing.** Add `@atproto/lexicon` as a dependency and check every outgoing record against the vendored schemas. A failure is a bug in the transformer and fails the test.
- Transformers (`src/transformers.ts`):
  - `toProfileRecord(persona)` → `com.cultureblocs.creative.profile`, using `name`, `bio`, `disciplines`, `based` (placeRef `{name}` only), `links`, `externalIds`, `createdAt`
  - `toWorkRecord(work)` → `com.cultureblocs.creative.work`, using `title`, `referenceUrl`, `completionDate`, `description`, `credits`, `tags`, `links`, `externalIds`, `createdAt` (no `images` yet; blobs are out of scope)
  - `toConnectionRecord(conn)` → `com.cultureblocs.creative.connection`, where `subject` is a `didRef` or a `strongRef`, plus `relationship`, `role`, `note`, `createdAt`
  - `createdAt` is set from the local `dateCreated` at first publish and never changes afterwards. That is the lexicon's "only immutable field".
- `src/adapters/atproto.ts`:
  - `publishPersona(doc, creds)` runs `putRecord` for the profile, then each work and connection (`rkey` = local TID). It then runs `deleteRecord` for every rkey in `publications.atproto.records` that is no longer present locally (deletes reach the network).
  - It records `{uri, cid, rkey}` for each item. Use `com.atproto.repo.applyWrites` once there are more than ~10 changes (one commit, atomic).
  - **One persona = one account.** Store `did` + `pdsUrl` per persona in `publications.atproto`, and refuse to publish persona B into persona A's DID. This protects pseudonymous personas from being linked by accident.
- **Sandbox:** generalise the `/sandbox/atproto/*` routes to accept any collection, plus add `deleteRecord` and `applyWrites`.
- `scripts/cleanup-legacy.ts` deletes `org.creativepassport.actor.persona/self` from the accounts found in M0 (dry run by default).

### Static and Solid

- Output: the public graph (the persona document minus `creativeid:private` and `creativeid:publications`), with `#me`, `#work-…` and `#claim-…` fragments.
- Turtle serializer: extend `toSolidTurtle` to the whole graph. Keep the hand-rolled serializer (no new dependency) but escape everything as now. Add a round-trip test: our parser (copied from the aggregator's `parseTurtlePersona`, extended) reads back what we write.
- Static default path: `/.well-known/creativeid.jsonld`. Keep the download option.

**Exit:** one persona with three works and two connections publishes to sandbox ATProto, sandbox Solid and static. Deleting a work locally and republishing removes it from the sandbox PDS. All outgoing ATProto records pass lexicon validation. 
✅ `test/m4-publish.test.ts`, 15 tests (65 in total).

### As built (done 2026-10-20)

- **Lexicons:** `scripts/vendor-lexicons.ts` (`npm run vendor-lexicons`) copies `defs`, `creative/profile`, `creative/work` and `creative/connection` from `cultureblocs-string` into `lexicons/`, with a README naming the source commit (`5ddcd13`). `lexicons/org/creativepassport/` is deleted. `@atproto/lexicon` validates every record **before any network call**.
- **`src/atproto/records.ts`:** `toProfileRecord` / `toWorkRecord` / `toConnectionRecord`, built from `toPublicDocument()` only. Connection subjects carry `$type` `com.cultureblocs.defs#didRef` or `#strongRef`, as `scripts/creative.py` writes them. `createdAt` is the local creation date. `planPublish()` sorts records into create / update / unchanged / delete by comparing modified dates with the last publish. It is exposed as `GET /api/personas/:id/publish/atproto/plan` for the M5 "2 new, 1 changed" summary.
- **`src/adapters/atproto.ts` · `publishPersona()`:** writes only new and changed records, with `putRecord` at stable rkeys, and deletes records removed locally. Unchanged records aren't rewritten.
  - **Deviation:** individual `putRecord` / `deleteRecord` calls rather than `applyWrites`. `putRecord` is an upsert, so it survives a PDS whose state has drifted. The cost is that a publish isn't atomic. To compensate, a failure part-way raises `PublishFailedError` carrying what did succeed, the API records that before returning 502, and local state therefore always matches the PDS.
- **One persona = one account**, enforced both ways: a persona bound to one DID refuses another (`AccountMismatchError`, 409), and the API refuses a DID that another persona already publishes to (409).
- **v1 cleanup happens automatically** when publishing to the same account: an `org.creativepassport.actor.persona/self` this tool wrote (known from the v1 import or an M3 publish) is deleted. `scripts/cleanup-legacy.ts` (`npm run cleanup-legacy`, dry run unless `--apply`) handles any other account.
- **`src/rdf.ts`:** the whole graph as JSON-LD (`toPublicJsonLd`) or Turtle (`toTurtle`). The public context types dates as `xsd:dateTime` and links and DIDs as IRIs. Ids stay relative; the public URL becomes `@base`. A test proves the two formats hold identical triples, using `jsonld` canonicalisation and the `n3` parser (dev dependencies only). `foaf:name` is dropped. Static and Solid publications now record `<document>#me`.
- **Removed:** `schema.ts`, `store.ts`, `transformers.ts`, `legacyBridge.ts`, plus the v1 unit tests (`milestone1/2`). `milestone3.test.ts` stays as an end-to-end test of the old UI routes, which now publish CultureBlocs records.
- **Sandbox PDS:** adds `deleteRecord` and `listRecords`, gives content-derived CIDs (same record → same CID), and answers 400 `RecordNotFound` like a real PDS.
- **Knock-on effect:** the aggregator still indexes `org.creativepassport.actor.persona`, so it won't see anything the studio publishes until **M6**.
- Publishing replaces any `com.cultureblocs.creative.profile/self` already in the account, for example one written with `cultureblocs-string/scripts/creative.py`. That is the intended single profile per account.

---

## M5 · Studio UI

- **Persona switcher** at the top: list, "New persona" (name only), rename, move to trash. Empty state: "Make your first persona. It stays on this computer until you choose to publish."
- **Profile panel:** name, bio, disciplines as free-text chips (placeholder examples from several practices: "sculpture", "stand-up", "curating", "lighting design"), based (text), links, external IDs (scheme dropdown from the lexicon's known values plus "other").
- **Works panel:** list plus a form (title, URL, completion date as free text, description, credits with optional DID, tags).
- **Connections panel:** "I … with/at …" form. Relationship dropdown (performed, exhibited, curated, collaborated_on, represented_by, member_of, released, created, references); target by handle/DID or by a pasted `at://` URI (resolve CID on paste where online, else store the URI only).
- **Inspector:** tabs for public JSON-LD, Turtle, and ATProto (one sub-tab per record type).
- **Publish hub:** per persona. Show which DID/URL it is bound to and the last publish time for each target. Show a diff count ("2 new, 1 changed, 1 to delete") before publishing.
- **Storage wizard:** make it work for any practice.
  - Rename "Name, biography & genres" to "Name, biography & disciplines".
  - Change "Legal name & rights identifiers (IPI, ISNI, ISRC, PRO)" to "Legal name & registration identifiers", with examples from several fields.
  - Change "Fees, tech rider & availability" to "Fees, technical needs & availability".
  - Wire its "Only me" / "Shared" answers to the `creativeid:private` block, so choices made in the wizard actually decide what gets published.
- **Language:** no "verified", "unverified" or "complete your profile" anywhere.

**Exit:** a manual walkthrough with three test personas (visual artist, performer, curator) can create, edit, publish and delete each record type without touching JSON. Run an accessibility review on the main screens.

✅ 70 tests in total; accessibility check clean.

### As built (done 2026-10-20)

- **Design:** the persona preview is drawn as a gallery wall label (square-cut mounted card, bold name, *italic* work titles as in catalogues). It's the one bold element; the editor around it is quiet forms on a cool gallery-wall background, with one action colour (ultramarine). Helvetica Neue / system fonts only, so the studio stays offline. Light and dark themes. Section tabs are peers (Profile, Works, Connections, Private, Publish), so they aren't numbered.
- **Personas:** a switcher in the masthead, "New persona" (name only), and move to trash with an inline confirm. The first run opens with "Make your first persona. It stays on this computer until you choose to publish."
- **Profile:** name and bio (counters appear near the limit), disciplines and tags as free-text chips, based-in, repeatable links and identifier rows (scheme list from the lexicon; any scheme already stored is kept).
- **Works:** list plus inline form. New works start with you in the credits; the wall label hides self-credits.
- **Connections:** "I … with/at …" phrasing, relationship list plus your own word, and a target box taking a handle, DID or `at://` link. **Look up** (`GET /api/resolve`, new `src/resolve.ts`) turns a handle into a DID (the handle's own `/.well-known/atproto-did`, then the public API), reads a DID's handle and PDS (plc.directory or did:web), and pins an `at://` link to its current CID. Saving a handle looks it up automatically. Unpinned record links show a gentle note.
- **Private:** key/value list stored in `creativeid:private`. Suggested keys come from whatever the Storage guide marked "Only me" or "Shared". This is how the wizard's answers now decide what stays out of publishing.
- **Publish:** per target, with the bound account and last publish date, the plan summary ("Ready to publish: 2 new, 1 changed, 1 to remove."), "Try it locally" for each sandbox, and an outcome line. App Passwords are cleared after each publish.
- **Storage guide:** wording made practice-neutral (no genres, PRO or tech rider); its gradient nav removed; unticked rows use muted text instead of 55% opacity (contrast).
- **Removed:** the single-persona `/api/persona`, `/api/export/download` and `/api/publish/*` routes, and `milestone3.test.ts`, which tested them.
- **Checked in a real browser** (Playwright + axe-core, WCAG 2.1 AA plus best practice) across first run, connections, publish, works and the storage guide, in light and dark: **no violations, no console errors, no horizontal scroll at 390 px.** Fixes from that pass: a real `<h1>`, darker "published" green, a switcher that wraps on phones, and a favicon.
- **Tests:** `test/m5-ui-api.test.ts` covers look-ups (handle, public API fallback, did:plc, did:web, CID pinning and each failure message), that the retired routes are gone, Solid and static publishing through the API, and that every element `app.js` uses exists in the page.

---

## M6 · Aggregator: CreativeID Aggregator

- **Collections:** `ATPROTO_COLLECTIONS = ["com.cultureblocs.creative.profile", "…work", "…connection"]`. Jetstream subscribes with `wantedCollections=com.cultureblocs.creative.*`; check that the Jetstream instance in use accepts NSID prefix wildcards, and otherwise list all three. Handle `create`, `update` and `delete` for each.
- **Types** (`src/types.ts`):
  - `IndexedArtist` becomes `IndexedPersona`, gaining `disciplines`, `based`, `links`, `externalIds`.
  - New `IndexedWork` and `IndexedConnection`, keyed by `at://` URI with their CID stored.
  - Static/Solid personas come in as one graph, split into the same three types.
- **Resolver:**
  - ATProto: `getRecord` for the profile plus `listRecords` for works and connections.
  - Static/Solid: parse the graph from `/.well-known/creativeid.jsonld` or `.ttl`. Keep the 64 KB limit; raise it only with a reason (a graph with many works may need ~256 KB).
- **Loops** (`src/loops.ts`, new), computed at read time:
  - **peer:** A has a `connection` whose `subject.did` = B, and B has one whose `subject.did` = A.
  - **work attested:** a `connection` from X with a `strongRef` to a `work` in Y's repo.
  - **CID check:** the strongRef's `cid` equals the work's current CID; if not, set `changedSinceAttested: true`.
  - Each result comes back as a plain list of loops, e.g. `{ type, from, to, recordUri, attestedAt, changedSinceAttested }`. No score.
- **API:**

| Method | Path |
|---|---|
| GET | `/v1/personas?q=&discipline=&based=&protocol=&limit=&offset=` |
| GET | `/v1/personas/:id` (DID, handle, domain, WebID or index id) → profile + counts |
| GET | `/v1/personas/:id/works`, `/v1/personas/:id/connections`, `/v1/personas/:id/loops` |
| GET | `/v1/works/:atUri` → work + loops |
| POST | `/v1/index` (unchanged contract) |
| POST | `/v1/jetstream/event` (any of the three collections) |
| GET | `/v1/stats` (counts per record type and protocol) |

- **Seed data:** replace the music-only demo profiles with a mixed set (visual artist, performer, curator, collective, lighting designer). Include one peer loop, one venue-attested work, and one changed-since-attested case.
- **Demo UI:** discipline filter; a persona page with works and connections, showing loops as sentences ("Attested by @venue on 14 Aug 2026"); and a visible "changed since attested" note.
- **Studio link:** an optional setting in the studio, "Tell these indexes when I publish". It holds a list of URLs, defaulting to empty (off), and sends `POST /v1/index` after each successful publish.

**Exit:** the existing aggregator tests are ported, and new tests cover each loop type plus the CID-mismatch case. In an end-to-end run, the studio publishes to the sandbox, pings the aggregator, and the persona can be found by discipline with its works and loops.

✅ Aggregator: 24 tests. Studio: 73 tests (3 new). End-to-end and browser checks pass.

### As built (done 2026-10-20)

**Aggregator (`creativeid-aggregator`), largely rewritten:**
- **Three record types**: personas, works and connections (`src/types.ts`), kept as one atomic `data/index.json`. An old v1 index is set aside as `.v1.bak`. Re-indexing a persona replaces everything held for it, so deletions at the source disappear here too.
- **`src/graph.ts`** reads ATProto records, the studio's JSON-LD (or a v1 single node) and its Turtle (with `n3`) into one shape. A test checks that all three give an identical persona, using fixtures generated from the studio's own code (`creativeid-studio/scripts/aggregator-fixtures.ts`). Published data is untrusted: values are type-checked, capped at lexicon limits, and malformed records are dropped rather than fatal.
- **`src/resolver.ts`**: ATProto by at:// link, DID or @handle (handle → DID → PDS, with listRecords paginated), static by URL or bare domain (`/.well-known/creativeid.jsonld`), and Solid. Documents are capped at 256 KB and 10 s.
- **`src/loops.ts`**: peer loops (each names the other, reported once) and work loops (someone points at another person's work). These carry `pinned` and `changedSinceAttested`. Computed on read and cached until the next write.
- **`src/jetstream.ts`**: a real Jetstream listener (there wasn't one before, only a POST endpoint). It subscribes to the three collections listed explicitly, so no wildcard support is needed, keeps a cursor file, rewinds 5 s on reconnect, and backs off up to 60 s. **Off unless `JETSTREAM=on`.**
- **API** as planned (`/v1/personas…`, `/v1/works/:uri`), plus `/v1/disciplines`. `/v1/artists` is retired. A public instance refuses to fetch from private networks (checked by host name); a local run allows it, so a studio on the same machine can be indexed.
- **Demo data** replaced: the v1 seeds used real musicians' names with invented DIDs. They are now five **fictional** personas on `.example` domains (lighting designer, sound collective, venue, choreographer, curator), with one peer loop, one confirmed work and one work changed since it was confirmed.
- **Directory page**: rebuilt in the studio's visual language. Search by words, discipline, place and protocol; persona pages show works, "Worked with", "Others who name them", and matches as sentences, never badges. Each persona has a linkable address (`#/persona/<id>`).

**Studio:**
- **"Directories to tell when you publish"** (Publish section; `data/settings.json`, `GET/PUT /api/settings`). It is empty by default. After each successful publish the studio sends `POST /v1/index` to each directory: AT Protocol with DID, PDS and handle; Solid with the resource URL; a static file only if it has a public URL. A directory that's down is reported, and the publish still succeeds. Settings sit beside the personas folder, so tests never notify a real directory.
- The ATProto publish result now includes the handle the account signed in with.

**Checked end to end** (real studio and aggregator side by side): three personas published to the sandbox PDS and the directory was told automatically. The peer loop and the venue's confirmation of a work appeared. After the work was edited and republished, the confirmation showed as changed. A Solid publish was indexed too. The directory page in Chromium with axe-core (WCAG 2.1 AA): no violations or console errors in light or dark, and no sideways scroll at 390 px.

**Known gaps:**
- The same persona published to two places (e.g. AT Protocol and Solid) appears as **two entries**, because nothing in the data links them. A future fix could carry the DID in the graph as `sameAs`.
- The private-network check is by host name only; DNS rebinding isn't covered, so a public instance should also sit behind an egress firewall.
- Static and Solid personas can make claims, but can't be the far end of a peer loop, because loops match on DIDs.

---

## M7 · Docs and ADRs

- `docs/adr/001-creativeid-naming-and-namespace.md`: covers D1–D3 and D7, and why `org.creativepassport.*` was retired.
- `docs/adr/002-local-persona-store.md`: covers D4, the one-persona-one-account rule, and the private block.
- Rewrite `README.md` and `SCOPE.md` as v2. Update the briefing and aggregator architecture docs (new collection names, `/.well-known/creativeid.jsonld`, `/v1/personas`).
- In `cultureblocs-string`: add `curated` to `creative.connection` `knownValues`, link the studio from `ROADMAP.md` §4, and add a short note to `CREATIVE-AND-VENUE.md`.

---

## Out of scope (later roadmap phases)

Images and blobs on works · `did:key` for unpublished personas · keychain credential storage · ATProto OAuth · suggestions rail for reciprocal claims · `<cultureblocs-persona>` embed · merging the aggregator into the CultureBlocs AppView · String sync · tier-4 credentials · CAWG assertions.

## Order and rough size

| Milestone | Depends on | Size |
|---|---|---|
| M0 Prepare | — | ½ day |
| M1 Rename (both repos) | M0 | ½–1 day |
| M2 Model v2 | M1 | 1–2 days |
| M3 Store + API | M2 | 1 day |
| M4 Publish to CultureBlocs lexicons | M3 | 2 days |
| M5 Studio UI | M3 (can overlap M4) | 2–3 days |
| M6 Aggregator | M4 (record shapes final) | 2–3 days |
| M7 Docs + ADRs | alongside each milestone | ½ day |

Each milestone is one PR per repo, keeping tests green. M1 is a pure rename so its diff can be checked quickly.
