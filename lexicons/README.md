# Vendored lexicons — do not edit

Read-only copies of the CultureBlocs lexicons this studio publishes. The
schema authority for `com.cultureblocs.*` is cultureblocs.com
(https://www.cultureblocs.com/lexicons.html); the source of truth is the
`cultureblocs-string` repository.

- Copied from: `cultureblocs-string/lexicons`
- Source commit: 970b41d 2026-10-20
- Files: `com/cultureblocs/defs.json`, `com/cultureblocs/creative/profile.json`, `com/cultureblocs/creative/work.json`, `com/cultureblocs/creative/connection.json`

Every record the studio sends to an ATProto PDS is validated against these
first. To update: change the lexicons in cultureblocs-string, then run
`npm run vendor-lexicons`.
