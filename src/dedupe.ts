import { listOccurrences, type CalDavEvent } from "./caldav.js";
import { pairsFor, type Config } from "./config.js";
import { eventProp, normalizeDateLine, propName, propValue, sourceRef, unfold } from "./ics.js";
import { createJevMatcher, type JevEvent, type JevComparison } from "./jev.js";
import { window, type Window } from "./sync.js";

export type ReviewEvent = JevEvent & {
  pair: string;
  side: string;
  href: string;
  uid: string;
  recurrenceId: string | null;
};
export type DedupeReview = {
  mode: "review";
  comparisons: number;
  skippedEvents: number;
  unavailable: number;
  truncated: boolean;
  errors: string[];
  suggestions: { keep: ReviewEvent; duplicate: ReviewEvent; probability: number }[];
};

const text = (s: string) => s.replace(/\\[nN]/g, "\n").replace(/\\([,;\\])/g, "$1");
function date(line: string | undefined): { ms: number; allDay: boolean } | null {
  if (!line) return null;
  const v = propValue(line);
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(v);
  if (!match) return null;
  const [, y, m, d, h, min, sec] = match;
  const utc = new Date(Date.UTC(+y, +m - 1, +d, +(h ?? 0), +(min ?? 0), +(sec ?? 0)));
  if (
    utc.getUTCFullYear() !== +y ||
    utc.getUTCMonth() !== +m - 1 ||
    utc.getUTCDate() !== +d ||
    (h !== undefined && (+h > 23 || +min > 59 || +sec > 59))
  )
    return null;
  if (h === undefined) return { ms: utc.getTime(), allDay: true };
  const normalized = normalizeDateLine(line).split("=")[1];
  // Floating times or unrecognized TZIDs are ambiguous. Do not guess.
  return /^-?\d+$/.test(normalized) ? { ms: Number(normalized), allDay: false } : null;
}

/** Expanded data only. Skip mirrors, cancellations, and unsupported occurrences. */
export function reviewEvents(resources: CalDavEvent[], pair: string, side: string, win: Window) {
  const events: ReviewEvent[] = [];
  let skipped = 0;
  for (const resource of resources) {
    const lines = unfold(resource.ics);
    let component: string[] | null = null;
    let depth = 0;
    for (const line of lines) {
      if (line === "BEGIN:VEVENT") {
        component = [line];
        depth = 1;
        continue;
      }
      if (!component) continue;
      if (line === "END:VEVENT") {
        component.push(line);
        const get = (name: string) => eventProp(component!, name);
        if (!sourceRef(component) && get("STATUS") !== "CANCELLED") {
          const start = date(component.find((l) => propName(l) === "DTSTART"));
          let end = date(component.find((l) => propName(l) === "DTEND"));
          if (!end && !get("DTEND") && start?.allDay && !get("DURATION"))
            end = { ms: start.ms + 86400000, allDay: true };
          const title = text(get("SUMMARY") ?? "").trim();
          const location = text(get("LOCATION") ?? "").trim();
          const uid = get("UID");
          if (
            !uid ||
            !start ||
            !end ||
            start.allDay !== end.allDay ||
            end.ms <= start.ms ||
            get("RRULE") ||
            get("RDATE") ||
            get("EXDATE") ||
            !title ||
            title.length > 500 ||
            location.length > 500
          )
            skipped++;
          else if (start.ms < win.end.getTime() && end.ms > win.start.getTime())
            events.push({
              pair,
              side,
              href: resource.href,
              uid,
              recurrenceId: get("RECURRENCE-ID"),
              title,
              location,
              start: start.ms,
              end: end.ms,
              allDay: start.allDay,
            });
        }
        component = null;
      } else {
        if (line.startsWith("BEGIN:")) depth++;
        if (depth === 1) component.push(line);
        if (line.startsWith("END:")) depth--;
      }
    }
  }
  return { events, skipped };
}

/** Explicit read-only review. Never invokes syncPair or any calendar write. */
export async function reviewDuplicates(
  config: Config,
  options: {
    range?: Window;
    list?: typeof listOccurrences;
    compare?: (a: JevEvent, b: JevEvent) => Promise<JevComparison>;
  } = {},
): Promise<DedupeReview> {
  if (!config.dedupe) throw new Error("Configure dedupe before running review");
  const { dedupe } = config;
  const range = options.range ?? window(config.window.pastDays, config.window.futureDays);
  const report: DedupeReview = {
    mode: "review",
    comparisons: 0,
    skippedEvents: 0,
    unavailable: 0,
    truncated: false,
    errors: [],
    suggestions: [],
  };
  const names = new Set(dedupe.rules.flatMap((r) => [r.prefer, ...r.over]));
  const loaded = new Map<string, ReviewEvent[]>();
  for (const pair of pairsFor(config).filter((p) => names.has(p.name))) {
    const events: ReviewEvent[] = [];
    for (const side of [pair.a, pair.b]) {
      try {
        const parsed = reviewEvents(
          await (options.list ?? listOccurrences)(side.auth, side.url, range),
          pair.name,
          side.id,
          range,
        );
        events.push(...parsed.events);
        report.skippedEvents += parsed.skipped;
      } catch {
        report.errors.push(`Could not read ${pair.name} (${side.id}); review is incomplete`);
      }
    }
    loaded.set(pair.name, events);
  }
  const compare = options.compare ?? createJevMatcher(dedupe).compare;
  const deadline = Date.now() + 20000;
  const seen = new Set<string>();
  for (const rule of dedupe.rules) {
    for (const name of rule.over) {
      for (const keep of loaded.get(rule.prefer) ?? []) {
        for (const duplicate of loaded.get(name) ?? []) {
          if (keep.start >= duplicate.end || duplicate.start >= keep.end) continue;
          if (keep.href === duplicate.href) continue;
          const key = JSON.stringify([keep.href, keep.start, duplicate.href, duplicate.start]);
          if (seen.has(key)) continue;
          seen.add(key);
          if (report.comparisons >= dedupe.maxComparisons || Date.now() >= deadline) {
            report.truncated = true;
            return report;
          }
          report.comparisons++;
          const result = await compare(keep, duplicate);
          if (result.status === "unavailable") report.unavailable++;
          if (result.status === "classified" && result.probability >= dedupe.threshold) {
            report.suggestions.push({ keep, duplicate, probability: result.probability });
          }
        }
      }
    }
  }
  return report;
}
