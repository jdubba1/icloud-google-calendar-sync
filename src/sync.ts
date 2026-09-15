// Two-way mirror between a pair of CalDAV calendars, stateless by design.
//
// Every event is either an ORIGINAL (created by a human or by Gmail on its
// home side) or a MIRROR (our copy on the other side, marked with
// X-SYNC-SOURCE:<side>:<uid> and X-SYNC-FP:<fingerprint-at-copy-time>). The
// planner looks at both sides and decides, per original:
//
//   no mirror yet            → create one
//   mirror unchanged, source changed → refresh the mirror
//   mirror changed (a human edited the copy) → push the edit back to the
//                              original; if both changed, later LAST-MODIFIED wins
//   mirror whose source is gone → delete the mirror (confirmed by a UID lookup
//                              outside the time window before acting)
//
// Deleting a mirror by hand does not delete the original; it comes back on the
// next run. Delete originals on the side they were created. See README.

import type { CalDavAuth, CalDavEvent } from "./caldav.js";
import { deleteEvent, findByUid, listEvents, putEvent } from "./caldav.js";
import {
  fingerprint,
  fold,
  lastModifiedMs,
  mirrorUid,
  sourceRef,
  toMirror,
  toOriginal,
  uidOf,
  unfold,
  X_FP,
  eventProp,
} from "./ics.js";

export type Side = { id: string; auth: CalDavAuth; url: string };
export type Pair = { name: string; a: Side; b: Side };

export type Parsed = CalDavEvent & {
  uid: string;
  lines: string[];
  fp: string;
  modified: number;
  source: { side: string; uid: string } | null;
  fpAtCopy: string | null;
};

export function parse(ev: CalDavEvent): Parsed | null {
  const lines = unfold(ev.ics);
  const uid = uidOf(lines);
  if (!uid) return null;
  return {
    ...ev,
    uid,
    lines,
    fp: fingerprint(lines),
    modified: lastModifiedMs(lines),
    source: sourceRef(lines),
    fpAtCopy: eventProp(lines, X_FP),
  };
}

export type Action =
  | { kind: "create"; on: string; href: string; ics: string; why: string }
  | { kind: "update"; on: string; href: string; etag: string | null; ics: string; why: string }
  | {
      kind: "delete-if-orphan";
      on: string;
      href: string;
      etag: string | null;
      sourceSide: string;
      sourceUid: string;
      why: string;
    };

/** Pure: decide what to do for one direction (originals on `from`, mirrors on `to`). */
export function planDirection(from: Side, to: Side, fromEvents: Parsed[], toEvents: Parsed[]): Action[] {
  const actions: Action[] = [];
  const mirrorsOnTo = new Map<string, Parsed>();
  for (const e of toEvents) if (e.source?.side === from.id) mirrorsOnTo.set(e.source.uid, e);
  const originalsOnFrom = new Map<string, Parsed>();
  for (const e of fromEvents) if (!e.source) originalsOnFrom.set(e.uid, e);

  for (const [uid, orig] of originalsOnFrom) {
    const mirror = mirrorsOnTo.get(uid);
    const mUid = mirrorUid(from.id, uid);
    if (!mirror) {
      const ics = fold(toMirror(orig.lines, { uid: mUid, sourceSide: from.id, sourceUid: uid, fp: orig.fp }));
      actions.push({
        kind: "create",
        on: to.id,
        href: to.url + encodeURIComponent(mUid) + ".ics",
        ics,
        why: `new original ${uid} on ${from.id}`,
      });
      continue;
    }
    const sourceChanged = orig.fp !== mirror.fpAtCopy;
    const mirrorChanged = mirror.fp !== mirror.fpAtCopy;
    if (!sourceChanged && !mirrorChanged) continue;
    if (orig.fp === mirror.fp) {
      // Same content, stale stamp (e.g. the fingerprint rules changed): fix the
      // stamp, touch nothing a human can see.
      const restamped = fold(
        toMirror(mirror.lines, {
          uid: mirror.uid,
          sourceSide: from.id,
          sourceUid: uid,
          fp: mirror.fp,
        }),
      );
      actions.push({
        kind: "update",
        on: to.id,
        href: mirror.href,
        etag: mirror.etag,
        ics: restamped,
        why: `re-stamp ${mirror.uid} (content already equal)`,
      });
      continue;
    }
    if (orig.fp === mirror.fp) {
      // Same content, stale stamp (e.g. the fingerprint rules changed): fix the
      // stamp, touch nothing a human can see.
      const restamped = fold(
        toMirror(mirror.lines, {
          uid: mirror.uid,
          sourceSide: from.id,
          sourceUid: uid,
          fp: mirror.fp,
        }),
      );
      actions.push({
        kind: "update",
        on: to.id,
        href: mirror.href,
        etag: mirror.etag,
        ics: restamped,
        why: `re-stamp ${mirror.uid} (content already equal)`,
      });
      continue;
    }
    if (mirrorChanged && (!sourceChanged || mirror.modified > orig.modified)) {
      // A human edited the copy: push it back, then re-stamp the copy.
      const original = fold(toOriginal(mirror.lines, uid));
      actions.push({
        kind: "update",
        on: from.id,
        href: orig.href,
        etag: orig.etag,
        ics: original,
        why: `mirror ${mirror.uid} edited on ${to.id}`,
      });
      const restamped = fold(
        toMirror(mirror.lines, {
          uid: mirror.uid,
          sourceSide: from.id,
          sourceUid: uid,
          fp: mirror.fp,
        }),
      );
      actions.push({
        kind: "update",
        on: to.id,
        href: mirror.href,
        etag: mirror.etag,
        ics: restamped,
        why: `re-stamp ${mirror.uid}`,
      });
      continue;
    }
    const ics = fold(toMirror(orig.lines, { uid: mirror.uid, sourceSide: from.id, sourceUid: uid, fp: orig.fp }));
    actions.push({
      kind: "update",
      on: to.id,
      href: mirror.href,
      etag: mirror.etag,
      ics,
      why: `original ${uid} changed on ${from.id}`,
    });
  }

  for (const [uid, mirror] of mirrorsOnTo) {
    if (originalsOnFrom.has(uid)) continue;
    actions.push({
      kind: "delete-if-orphan",
      on: to.id,
      href: mirror.href,
      etag: mirror.etag,
      sourceSide: from.id,
      sourceUid: uid,
      why: `source ${uid} not in window on ${from.id}`,
    });
  }
  return actions;
}

export function plan(pair: Pair, aEvents: Parsed[], bEvents: Parsed[]): Action[] {
  return [...planDirection(pair.a, pair.b, aEvents, bEvents), ...planDirection(pair.b, pair.a, bEvents, aEvents)];
}

export type PairResult = {
  pair: string;
  a: number;
  b: number;
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  errors: string[];
  actions?: Action[];
};

export type Window = { start: Date; end: Date };

export function window(pastDays: number, futureDays: number, now = new Date()): Window {
  return {
    start: new Date(now.getTime() - pastDays * 86400_000),
    end: new Date(now.getTime() + futureDays * 86400_000),
  };
}

export async function syncPair(pair: Pair, win: Window, opts: { dryRun?: boolean } = {}): Promise<PairResult> {
  const [aRaw, bRaw] = await Promise.all([
    listEvents(pair.a.auth, pair.a.url, win),
    listEvents(pair.b.auth, pair.b.url, win),
  ]);
  const aEvents = aRaw.map(parse).filter((e): e is Parsed => e != null);
  const bEvents = bRaw.map(parse).filter((e): e is Parsed => e != null);
  const actions = plan(pair, aEvents, bEvents);
  const result: PairResult = {
    pair: pair.name,
    a: aEvents.length,
    b: bEvents.length,
    created: 0,
    updated: 0,
    deleted: 0,
    skipped: 0,
    errors: [],
  };
  if (opts.dryRun) return { ...result, actions };

  const sides = new Map<string, Side>([
    [pair.a.id, pair.a],
    [pair.b.id, pair.b],
  ]);
  for (const act of actions) {
    const side = sides.get(act.on);
    if (!side) continue;
    try {
      await apply(act, side, sides, result);
    } catch (e) {
      result.errors.push(`${act.kind} ${act.href}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return result;
}

async function apply(act: Action, side: Side, sides: Map<string, Side>, result: PairResult): Promise<void> {
  if (act.kind === "create") {
    await putEvent(side.auth, act.href, act.ics, { create: true });
    result.created++;
    return;
  }
  if (act.kind === "update") {
    await putEvent(side.auth, act.href, act.ics, { etag: act.etag });
    result.updated++;
    return;
  }
  const src = sides.get(act.sourceSide);
  if (!src) return;
  const stillThere = await findByUid(src.auth, src.url, act.sourceUid);
  if (stillThere) {
    result.skipped++;
    return;
  }
  await deleteEvent(side.auth, act.href, act.etag);
  result.deleted++;
}
