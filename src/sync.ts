// Two-way mirror between a pair of CalDAV calendars, stateless by design.
//
// Every event is an ORIGINAL or a MIRROR (our copy on the other side, marked
// X-SYNC-SOURCE:<side>:<uid> and X-SYNC-FP:<fingerprint at copy time>). Per
// original: no mirror → create; original changed → refresh mirror; mirror
// changed → push the edit back (both changed → later LAST-MODIFIED wins);
// mirror whose original is gone → delete it, after a UID lookup confirms.
// Deleting a mirror by hand does not delete the original; it comes back.

import type { CalDavAuth, CalDavEvent } from "./caldav.js";
import { deleteEvent, findByUid, listEvents, putEvent } from "./caldav.js";
import {
  eventProp,
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
} from "./ics.js";

export type Side = { id: string; auth: CalDavAuth; url: string };
export type Pair = { name: string; a: Side; b: Side };
export type Window = { start: Date; end: Date };

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
  return uid
    ? {
        ...ev,
        uid,
        lines,
        fp: fingerprint(lines),
        modified: lastModifiedMs(lines),
        source: sourceRef(lines),
        fpAtCopy: eventProp(lines, X_FP),
      }
    : null;
}

/** `etag: null` on a put means create. */
export type Action =
  | { kind: "put"; on: string; href: string; etag: string | null; ics: string; why: string }
  | {
      kind: "delete-if-orphan";
      on: string;
      href: string;
      etag: string | null;
      sourceSide: string;
      sourceUid: string;
      why: string;
    };

/** Pure: originals on `from`, mirrors on `to`. */
export function planDirection(from: Side, to: Side, fromEvents: Parsed[], toEvents: Parsed[]): Action[] {
  const originals = new Map(fromEvents.filter((e) => !e.source).map((e) => [e.uid, e]));
  const mirrors = new Map(toEvents.filter((e) => e.source?.side === from.id).map((e) => [e.source!.uid, e]));
  const put = (on: string, ev: { href: string; etag: string | null }, ics: string[], why: string): Action => ({
    kind: "put",
    on,
    href: ev.href,
    etag: ev.etag,
    ics: fold(ics),
    why,
  });
  const mirrorOf = (src: Parsed, uid: string, fp: string) =>
    toMirror(src.lines, { uid, sourceSide: from.id, sourceUid: src.uid, fp });
  const actions: Action[] = [];

  for (const [uid, orig] of originals) {
    const mirror = mirrors.get(uid);
    if (!mirror) {
      const mUid = mirrorUid(from.id, uid);
      actions.push(
        put(
          to.id,
          { href: to.url + encodeURIComponent(mUid) + ".ics", etag: null },
          mirrorOf(orig, mUid, orig.fp),
          `new original ${uid} on ${from.id}`,
        ),
      );
    } else if (orig.fp === mirror.fpAtCopy && mirror.fp === mirror.fpAtCopy) {
      continue;
    } else if (orig.fp === mirror.fp) {
      // Same content, stale stamp (e.g. fingerprint rules changed): fix the stamp only.
      actions.push(
        put(
          to.id,
          mirror,
          toMirror(mirror.lines, { uid: mirror.uid, sourceSide: from.id, sourceUid: uid, fp: mirror.fp }),
          `re-stamp ${mirror.uid} (content already equal)`,
        ),
      );
    } else if (mirror.fp !== mirror.fpAtCopy && (orig.fp === mirror.fpAtCopy || mirror.modified > orig.modified)) {
      // A human edited the copy: push it back, then re-stamp the copy.
      actions.push(put(from.id, orig, toOriginal(mirror.lines, uid), `mirror ${mirror.uid} edited on ${to.id}`));
      actions.push(
        put(
          to.id,
          mirror,
          toMirror(mirror.lines, { uid: mirror.uid, sourceSide: from.id, sourceUid: uid, fp: mirror.fp }),
          `re-stamp ${mirror.uid}`,
        ),
      );
    } else {
      actions.push(put(to.id, mirror, mirrorOf(orig, mirror.uid, orig.fp), `original ${uid} changed on ${from.id}`));
    }
  }
  for (const [uid, mirror] of mirrors) {
    if (!originals.has(uid))
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

export const plan = (pair: Pair, a: Parsed[], b: Parsed[]): Action[] => [
  ...planDirection(pair.a, pair.b, a, b),
  ...planDirection(pair.b, pair.a, b, a),
];

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

export const window = (pastDays: number, futureDays: number, now = new Date()): Window => ({
  start: new Date(now.getTime() - pastDays * 86400_000),
  end: new Date(now.getTime() + futureDays * 86400_000),
});

export async function syncPair(pair: Pair, win: Window, opts: { dryRun?: boolean } = {}): Promise<PairResult> {
  const load = async (s: Side) =>
    (await listEvents(s.auth, s.url, win)).map(parse).filter((e): e is Parsed => e != null);
  const [a, b] = await Promise.all([load(pair.a), load(pair.b)]);
  const actions = plan(pair, a, b);
  const result: PairResult = {
    pair: pair.name,
    a: a.length,
    b: b.length,
    created: 0,
    updated: 0,
    deleted: 0,
    skipped: 0,
    errors: [],
  };
  if (opts.dryRun) return { ...result, actions };

  const sides = new Map([pair.a, pair.b].map((s) => [s.id, s]));
  for (const act of actions) {
    const side = sides.get(act.on)!;
    try {
      if (act.kind === "put") {
        await putEvent(side.auth, act.href, act.ics, act.etag);
        act.etag ? result.updated++ : result.created++;
      } else {
        const src = sides.get(act.sourceSide)!;
        if (await findByUid(src.auth, src.url, act.sourceUid)) result.skipped++;
        else (await deleteEvent(side.auth, act.href, act.etag), result.deleted++);
      }
    } catch (e) {
      result.errors.push(`${act.kind} ${act.href}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return result;
}
