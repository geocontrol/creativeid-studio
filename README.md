# CreativeID Studio (v1)

> Formerly the **Creative Passport** prototype, renamed to CreativeID on 2026-10-19. See [PERSONA_STUDIO_PLAN.md](PERSONA_STUDIO_PLAN.md) for where it is heading.

A **local-first** studio and dataset publisher for authoring your creative persona (Name & Biography) as canonical Linked Data (`JSON-LD`) and publishing it to:
- **AT Protocol PDS** (`org.creativepassport.actor.persona` Lexicon record)
- **Solid Data Pods** (`text/turtle` or `application/ld+json` via HTTP `PUT`)
- **Static Dataset Files** (`creativeid.jsonld` / `creativeid.ttl` for personal domains, GitHub Pages, S3, or IPFS)

## Quick Start

```bash
cd ~/Projects/creativeid-studio
npm install
npm start
```

Open **http://localhost:3400** in your browser.

### Features
1. **Author Locally**: Create one or more personas, each with a profile, works and connections. Each persona is one JSON-LD file in `data/personas/`, written atomically; deleted personas go to `data/personas/.trash/`. An older `data/persona.jsonld` is imported automatically on first start (kept as `persona.v1.jsonld.bak`).
2. **Live Dataset Inspector**: Inspect your persona in real time as:
   - Canonical Local JSON-LD
   - Public JSON-LD (`schema.org/Person` + `foaf:Person`)
   - AT Protocol Lexicon JSON (`org.creativepassport.actor.persona`)
   - Solid RDF Turtle (`text/turtle`)
3. **Publish Anywhere**:
   - Use your real **ATProto PDS** handle + App Password or **Solid Pod** resource URL, or click **"Use Local Sandbox"** on either card to test end-to-end publishing locally without external credentials.
   - Export or download standalone `.jsonld` and `.ttl` files.

## Development & Tests

```bash
npm test        # Run all unit & end-to-end tests (Milestones 1–4)
npm run build   # Compile TypeScript to dist/
```
