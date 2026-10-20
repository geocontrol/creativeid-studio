# CreativeID Studio

> Formerly the **Creative Passport** prototype, renamed to CreativeID on 2026-10-19. See [PERSONA_STUDIO_PLAN.md](PERSONA_STUDIO_PLAN.md) for where it is heading.

A **local-first** studio for writing up your creative practice — a profile, the works you've made, and who you've worked with — on your own computer, and publishing it when you choose. Works for any practice: visual art, performance, curating, writing, sound, collectives, technical crafts.

Nothing needs an account to start. Each persona is a JSON-LD file on your machine; publishing copies its public parts to:
- **AT Protocol** as CultureBlocs records: `com.cultureblocs.creative.profile`, `.work` and `.connection`, validated against the lexicons in [`lexicons/`](lexicons/README.md) before anything is sent
- **Solid Pods** (Turtle or JSON-LD via HTTP `PUT`)
- **A file for your own website**, ideally at `/.well-known/creativeid.jsonld`

## Quick start

```bash
npm install
npm start
```

Open **http://localhost:3400**.

## What's in the studio

- **Personas.** As many as you need (a stage name and a legal name can be two). Switch between them at the top. Each is one file in `data/personas/`; moving one to the trash puts it in `data/personas/.trash/`. An older single-persona `data/persona.jsonld` is imported on first start and kept as `persona.v1.jsonld.bak`.
- **Profile, Works, Connections.** Plain forms; disciplines and tags in your own words. Connections take a handle, DID or `at://` link — **Look up** finds the DID, or pins a record to its current version (CID).
- **Private.** Details kept in the persona's file and never published. Suggestions come from your Storage guide answers.
- **Publish.** AT Protocol (shows what will change before you publish), a downloadable file, or a Solid Pod. **Try it locally** publishes to built-in sandboxes, so you can see the whole flow without an account.
- **Directories.** Optionally list CreativeID directories (such as [creativeid-aggregator](https://github.com/geocontrol/creativeid-aggregator), at `http://localhost:3500` when run locally) and each publish tells them where to find you. Empty by default; kept in `data/settings.json`.
- **How it reads.** A live wall-label preview of the persona, and "What gets published" showing the exact AT Protocol records, JSON-LD and Turtle.
- **Storage guide.** A short questionnaire that recommends where your persona should live.

Everything except publishing and Look up works offline.

## Local API

The UI uses a small JSON API on `localhost` (see `src/api.ts` for the full list): `/api/personas` for personas, works, connections, private fields, previews, downloads and publishing, and `/api/resolve?q=` for look-ups.

## Development & Tests

```bash
npm test           # unit, API and end-to-end tests
npm run typecheck  # type-check source, tests and scripts
npm run build   # Compile TypeScript to dist/
```
