# Changelog

## Unreleased

- Only send overlapping pairs to Jev when they share a title word or start time.
  Skipped pairs are counted in `unlikelyPairs`.
- Add an optional Jev `store` so scheduled reviews reuse results across runs.
- Add awaited `beforeAction` and `onAction` hooks for sync and individual dedupe
  deletions, with deterministic write IDs and grouped consolidation IDs.
- Preserve completed, skipped, failed, and uncertain outcomes. Observer failures
  stop execution without relabeling successful calendar writes.
- Thread cancellation through sync, review, consolidation, Google token refresh,
  and Jev. HTTP handlers also honor request cancellation.
- Add optional provider URL policies, checked before sending credentials and
  when returning discovery destinations. Custom CalDAV remains supported.
- Revalidate deletion conditions after awaited hooks.
- Require Node.js 20.3+ for native AbortSignal.any support.

- Add opt-in priority-based dedupe deletion, structured results, and an awaited
  `onDelete` hook. No database or recovery store required.
- Delete mirrors before originals and verify removal; skip unsupported or edited
  resources. Full sync runs cleanup only for explicit delete rules.
- Keep review and dry-run paths read-only.

## 0.4.0 — 2026-09-21

- Add priority-calendar rules and explicit read-only duplicate review through the CLI and authenticated HTTP handler.

- Add an optional `/jev` module for read-only duplicate suggestions through Vercel AI Gateway or TypeSafe directly. Normal syncing has no AI dependency.

## 0.3.0 (2026-09-21)

- Automatic deletion now requires explicit `propagateDeletes: true`. The default
  and `false` preserve orphaned mirrors and recreate missing mirrors, even for
  originals stamped by previous versions. Creates and edits continue to sync.
- Verify exact event UIDs in deletion checks. Google CalDAV can return unrelated
  events despite a UID filter, which previously kept orphaned mirrors visible.

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
