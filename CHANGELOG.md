# Changelog

## 0.2.2 (2026-09-15)

- A failed `X-SYNC-MIRRORED` stamp no longer stops the pair. Originals that
  reject writes (Google events generated from Gmail, invitations you don't
  organize) are reported under `warnings` and keep mirroring; only delete
  propagation for that event is lost. Previously one such event failed every
  run at the first action, so nothing synced and the handler returned 502.

## 0.2.1 (2026-09-15)

- Stop a pair after failed writes so originals are not stamped after failed mirror creation.
- Preserve and validate `propagateDeletes` in file and environment config.
- Implement custom authorization and combine migration stamps with pending edits.

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
