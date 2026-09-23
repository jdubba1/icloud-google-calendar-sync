import { createHash } from "node:crypto";
import { actionNotice, performAction, ActionObserverError, type ActionHooks } from "./execution.js";
import { CalDavError, dav, deleteEvent, listEvents, type CalDavEvent } from "./caldav.js";
import { pairsFor, type Config } from "./config.js";
import { reviewDuplicates, reviewEvents, type ReviewEvent } from "./dedupe.js";
import { eventProp, fingerprint, mirrorUid, sourceRef, uidOf, unfold, X_FP } from "./ics.js";
import type { Side, Window } from "./sync.js";

export type DeleteNotice = {
  /** Groups the physical deletions and their action callbacks. */
  consolidationId: string;
  phase: "before" | "completed";
  probability: number;
  keep: ReviewEvent;
  duplicate: ReviewEvent;
  /** Private recovery data. Persist in the before hook if undo is needed. */
  resources: CalDavEvent[];
};
export type DeleteOptions = Parameters<typeof reviewDuplicates>[1] &
  ActionHooks & {
    /** Awaited before any deletion and after verified completion. Throw before to veto. */
    onDelete?: (notice: DeleteNotice) => void | Promise<void>;
  };
export type DeleteResult = {
  keep: ReviewEvent;
  duplicate: ReviewEvent;
  probability: number;
  status: "deleted" | "skipped" | "failed";
  reason?: string;
  deletedCopies: number;
};

async function read(side: Side, href: string, uid: string): Promise<CalDavEvent | null> {
  const base = new URL(side.url),
    target = new URL(href);
  if (
    base.origin !== target.origin ||
    !target.pathname.startsWith(base.pathname.endsWith("/") ? base.pathname : base.pathname + "/")
  )
    throw new Error("Resource outside configured calendar");
  try {
    const result = await dav(side.auth, "GET", href);
    if (result.status !== 200 || uidOf(unfold(result.text)) !== uid) throw new Error("Resource identity changed");
    const etag = result.headers.get("etag");
    if (!etag || etag.startsWith("W/")) throw new Error("Strong ETag required");
    return { href, ics: result.text, etag };
  } catch (error) {
    if (error instanceof CalDavError && (error.status === 404 || error.status === 410)) return null;
    throw error;
  }
}
function single(resource: CalDavEvent) {
  const lines = unfold(resource.ics);
  if (
    lines.filter((l) => l === "BEGIN:VEVENT").length !== 1 ||
    ["RRULE", "RDATE", "EXDATE", "RECURRENCE-ID", "ORGANIZER", "ATTENDEE"].some((p) => eventProp(lines, p)) ||
    eventProp(lines, "STATUS") === "CANCELLED"
  )
    throw new Error("Unsupported event");
  return lines;
}
async function original(side: Side, event: ReviewEvent, range: Window) {
  const resource = await read(side, event.href, event.uid);
  if (!resource) throw new Error("Original missing");
  single(resource);
  const actual = reviewEvents([resource], event.pair, event.side, range).events[0];
  if (
    !actual ||
    ["uid", "title", "location", "start", "end", "allDay", "recurrenceId"].some(
      (k) => actual[k as keyof ReviewEvent] !== event[k as keyof ReviewEvent],
    )
  )
    throw new Error("Original changed since review");
  return resource;
}
async function unchanged(side: Side, resource: CalDavEvent) {
  const current = await read(side, resource.href, uidOf(unfold(resource.ics))!);
  if (!current || current.etag !== resource.etag || current.ics !== resource.ics) throw new Error("Resource changed");
}

/** Fresh review followed by opt-in cleanup. Serialize with ALL other calendar writers. */
export async function consolidateDuplicates(config: Config, options: DeleteOptions = {}) {
  options.signal?.throwIfAborted();
  const pairs = pairsFor(config, options);
  for (const rule of config.dedupe?.rules ?? []) {
    if (rule.mode !== "delete") continue;
    for (const name of [rule.prefer, ...rule.over]) {
      if (pairs.find((p) => p.name === name)?.propagateDeletes)
        throw new Error("Dedupe deletion requires propagateDeletes=false");
    }
  }
  const review = await reviewDuplicates(config, options);
  const results: DeleteResult[] = [];
  if (review.errors.length || review.unavailable || review.truncated) return { review, results, incomplete: true };
  const seen = new Set<string>();
  for (const suggestion of review.suggestions) {
    options.signal?.throwIfAborted();
    const { keep, duplicate } = suggestion;
    const consolidationId = createHash("sha256")
      .update(JSON.stringify([keep, duplicate]))
      .digest("hex");
    if (
      !config.dedupe!.rules.some(
        (r) => r.mode === "delete" && r.prefer === keep.pair && r.over.includes(duplicate.pair),
      )
    )
      continue;
    const key = JSON.stringify([duplicate.pair, duplicate.side, duplicate.uid]);
    if (seen.has(key)) continue;
    seen.add(key);
    const result: DeleteResult = { ...suggestion, status: "skipped", deletedCopies: 0 };
    results.push(result);
    let deleting = false;
    try {
      const kp = pairs.find((p) => p.name === keep.pair)!;
      const dp = pairs.find((p) => p.name === duplicate.pair)!;
      if (kp.a.id === kp.b.id || dp.a.id === dp.b.id) throw new Error("Distinct side IDs required");
      const ks = [kp.a, kp.b].find((s) => s.id === keep.side)!;
      const ds = [dp.a, dp.b].find((s) => s.id === duplicate.side)!;
      const ms = ds === dp.a ? dp.b : dp.a;
      if ([kp.a.url, kp.b.url].some((url) => [dp.a.url, dp.b.url].includes(url))) throw new Error("Calendars overlap");
      const range = {
        start: new Date(Math.min(keep.start, duplicate.start)),
        end: new Date(Math.max(keep.end, duplicate.end)),
      };
      const kept = await original(ks, keep, range);
      const dropped = await original(ds, duplicate, range);
      const uid = mirrorUid(ds.id, duplicate.uid);
      const candidates = (await listEvents(ms.auth, ms.url, range)).filter((e) => {
        const source = sourceRef(unfold(e.ics));
        return source?.side === ds.id && source.uid === duplicate.uid;
      });
      const canonical = await read(ms, ms.url + encodeURIComponent(uid) + ".ics", uid);
      if (canonical && !candidates.some((e) => e.href === canonical.href)) candidates.push(canonical);
      if (candidates.length > 1) throw new Error("Multiple mirrors");
      const mirror = candidates.length ? await read(ms, candidates[0].href, uid) : null;
      if (candidates.length && !mirror) throw new Error("Mirror changed");
      if (mirror) {
        const lines = single(mirror),
          source = sourceRef(lines);
        if (
          source?.side !== ds.id ||
          source.uid !== duplicate.uid ||
          fingerprint(lines) !== eventProp(lines, X_FP) ||
          fingerprint(lines) !== fingerprint(unfold(dropped.ics))
        )
          throw new Error("Mirror has independent edits");
      }
      const resources = mirror ? [dropped, mirror] : [dropped];
      // Give callers copies so a logging hook cannot mutate the deletion plan.
      await options.onDelete?.(structuredClone({ ...suggestion, consolidationId, phase: "before", resources }));
      await unchanged(ks, kept);
      await unchanged(ds, dropped);
      if (mirror) await unchanged(ms, mirror);
      const remove = async (side: Side, resource: CalDavEvent, uid: string) => {
        const notice = actionNotice({
          operation: "delete",
          pair: duplicate.pair,
          side: side.id,
          href: resource.href,
          etag: resource.etag,
          ics: resource.ics,
          internal: false,
          consolidationId,
        });
        await performAction(
          notice,
          async () => {
            // Awaited hooks may allow concurrent calendar edits. Revalidate after them.
            await unchanged(ks, kept);
            await unchanged(side, resource);
            if (side === ds) {
              const current = await listEvents(ms.auth, ms.url, range);
              if (
                current.some((event) => {
                  const source = sourceRef(unfold(event.ics));
                  return source?.side === ds.id && source.uid === duplicate.uid;
                }) ||
                (await read(
                  ms,
                  ms.url + encodeURIComponent(mirrorUid(ds.id, duplicate.uid)) + ".ics",
                  mirrorUid(ds.id, duplicate.uid),
                ))
              )
                throw new Error("Mirror appeared during cleanup");
            }
            options.signal?.throwIfAborted();
            await deleteEvent(side.auth, resource.href, resource.etag);
            try {
              if (await read(side, resource.href, uid)) throw new Error("Deletion not confirmed");
            } catch {
              // DELETE already succeeded: a failing verification GET is not a rejected write.
              throw new Error("Deletion verification failed; outcome uncertain");
            }
          },
          options,
        );
        result.deletedCopies++;
      };
      options.signal?.throwIfAborted();
      deleting = true;
      // Mirror first: interruption leaves the original for another fresh review.
      if (mirror) {
        await remove(ms, mirror, uid);
      }
      await remove(ds, dropped, duplicate.uid);
      result.status = "deleted";
      try {
        await options.onDelete?.(structuredClone({ ...suggestion, consolidationId, phase: "completed", resources }));
      } catch {
        result.reason = "Completion hook failed after verified deletion";
      }
    } catch (error) {
      if (error instanceof ActionObserverError) throw error;
      options.signal?.throwIfAborted();
      result.status = deleting ? "failed" : "skipped";
      result.reason = deleting
        ? "Cleanup interrupted; re-read calendars before retrying"
        : "Eligibility checks or before hook failed";
      if (deleting) break;
    }
  }
  return { review, results, incomplete: false };
}
