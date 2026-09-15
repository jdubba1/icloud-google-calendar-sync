# Changelog

## 0.2.0 (2026-09-15)

- Deletes propagate both ways: originals are stamped `X-SYNC-MIRRORED:<side>`
  when mirrored, and an original whose mirror was deleted by a human is
  deleted too (after a UID lookup confirms). Per-pair `propagateDeletes: false`
  opts out. Existing originals get stamped on the first run after upgrading.
- `createHandler` accepts `authorize(req)` as an alternative to `secret`.

## 0.1.0 (2026-09-15)

First release. Two-way iCloud ↔ Google mirror with stateless in-event
markers, attendee stripping, normalized fingerprints, a CLI (`auth google`,
`discover`, `sync --dry`) and a Fetch-API handler.
