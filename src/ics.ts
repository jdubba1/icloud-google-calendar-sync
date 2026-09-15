// iCalendar transport. We never interpret a calendar, we copy it: a mirror is
// the source VCALENDAR with the UID rewritten, ATTENDEE/ORGANIZER stripped (a
// mirror must never become an invitation) and two X-SYNC-* markers added.
import { createHash } from "node:crypto";

export const X_SOURCE = "X-SYNC-SOURCE";
export const X_FP = "X-SYNC-FP";

/** Undo RFC 5545 line folding. */
export function unfold(ics: string): string[] {
  const out: string[] = [];
  for (const raw of ics.split(/\r?\n/)) {
    if (/^[ \t]/.test(raw) && out.length) out[out.length - 1] += raw.slice(1);
    else if (raw) out.push(raw);
  }
  return out;
}

/** Fold at 75 octets, CRLF terminated. */
export function fold(lines: string[]): string {
  const bytes = (s: string) => Buffer.byteLength(s);
  return (
    lines
      .flatMap((line) => {
        const parts: string[] = [];
        let cur = "";
        for (const ch of line) {
          if (bytes(cur + ch) > (parts.length ? 74 : 75)) {
            parts.push(cur);
            cur = "";
          }
          cur += ch;
        }
        return [...parts, cur].map((p, i) => (i ? " " + p : p));
      })
      .join("\r\n") + "\r\n"
  );
}

export const propName = (line: string): string => (/^[A-Za-z0-9-]+/.exec(line)?.[0] ?? "").toUpperCase();
export const propValue = (line: string): string => line.slice(line.indexOf(":") + 1);

/** First VEVENT's value for a property, or null. */
export function eventProp(lines: string[], name: string): string | null {
  const start = lines.indexOf("BEGIN:VEVENT");
  const end = lines.indexOf("END:VEVENT", start);
  const hit = lines.slice(start + 1, end).find((l) => propName(l) === name);
  return hit == null ? null : propValue(hit);
}

export const uidOf = (lines: string[]) => eventProp(lines, "UID");

/** `X-SYNC-SOURCE:<side>:<uid>` on a mirror, null on an original. */
export function sourceRef(lines: string[]): { side: string; uid: string } | null {
  const m = /^([^:]+):(.+)$/.exec(eventProp(lines, X_SOURCE) ?? "");
  return m ? { side: m[1], uid: m[2] } : null;
}

const stampToMs = (v: string | null): number | null => {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(v?.trim() ?? "");
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
};

export const lastModifiedMs = (lines: string[]): number =>
  stampToMs(eventProp(lines, "LAST-MODIFIED")) ?? stampToMs(eventProp(lines, "DTSTAMP")) ?? 0;

// --- fingerprint: what a human would notice --------------------------------
// Servers freely rewrite PRODID, DTSTAMP, SEQUENCE and VTIMEZONE, and Google
// pads events with empty DESCRIPTION/LOCATION and default STATUS/TRANSP, so
// none of that may count as a change. Times compare as instants.

const FP_PROPS = new Set([
  "SUMMARY",
  "DTSTART",
  "DTEND",
  "DURATION",
  "RRULE",
  "RDATE",
  "EXDATE",
  "RECURRENCE-ID",
  "LOCATION",
  "DESCRIPTION",
  "STATUS",
  "TRANSP",
  "URL",
]);
const DEFAULTS: Record<string, string> = { STATUS: "CONFIRMED", TRANSP: "OPAQUE" };

/** Minutes east of UTC for an IANA zone at an instant; null if the zone is unknown. */
function zoneOffsetMin(tz: string, utcMs: number): number | null {
  try {
    const p: Record<string, number> = {};
    for (const part of new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(utcMs))) {
      if (part.type !== "literal") p[part.type] = Number(part.value);
    }
    return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utcMs) / 60_000);
  } catch {
    return null;
  }
}

/** DTSTART/DTEND/RECURRENCE-ID → comparable string (epoch ms, or the date, or the literal). */
export function normalizeDateLine(line: string): string {
  const name = propName(line);
  const value = propValue(line).trim();
  const tz = /;TZID="?([^;:"]+)/i.exec(line)?.[1];
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(value);
  if (!m) return `${name}=${value}`;
  if (!m[4]) return `${name}=D${value}`;
  const local = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (m[7] === "Z") return `${name}=${local}`;
  if (!tz) return `${name}=${local}F`;
  const off = zoneOffsetMin(tz, local);
  return off == null ? `${name}=${value}@${tz}` : `${name}=${local - off * 60_000}`;
}

const normalizeText = (v: string) =>
  v
    .replace(/\\n/g, "\n")
    .replace(/\\([,;\\])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

/** Stable fingerprint of the human-visible content of every VEVENT in the file. */
export function fingerprint(lines: string[]): string {
  const sig: string[] = [];
  let depth = 0; // 1 inside VEVENT, 2 inside a VALARM within it
  for (const l of lines) {
    if (l === "BEGIN:VEVENT") (sig.push("|"), (depth = 1));
    else if (l === "END:VEVENT") depth = 0;
    else if (l === "BEGIN:VALARM") depth = 2;
    else if (l === "END:VALARM") depth = 1;
    else if (depth === 1 && FP_PROPS.has(propName(l))) {
      const name = propName(l);
      if (/^(DTSTART|DTEND|RECURRENCE-ID)$/.test(name)) sig.push(normalizeDateLine(l));
      else {
        const value = normalizeText(propValue(l));
        if (value && DEFAULTS[name] !== value) sig.push(`${name}=${value}`);
      }
    }
  }
  return createHash("sha1").update(sig.sort().join("\n")).digest("hex").slice(0, 16);
}

// --- mirror construction ---------------------------------------------------

const STRIP = new Set(["ATTENDEE", "ORGANIZER", X_SOURCE, X_FP]);

/** Copy `lines`, giving every VEVENT the new UID, no attendees, and `markers` (if any) before END:VEVENT. */
function rewrite(lines: string[], uid: string, markers: string[]): string[] {
  let inEvent = false;
  return lines.flatMap((l) => {
    if (l === "BEGIN:VEVENT") inEvent = true;
    if (l === "END:VEVENT") return ((inEvent = false), [...markers, l]);
    if (!inEvent) return [l];
    const name = propName(l);
    return name === "UID" ? [`UID:${uid}`] : STRIP.has(name) ? [] : [l];
  });
}

export const toMirror = (source: string[], o: { uid: string; sourceSide: string; sourceUid: string; fp: string }) =>
  rewrite(source, o.uid, [`${X_SOURCE}:${o.sourceSide}:${o.sourceUid}`, `${X_FP}:${o.fp}`]);

export const toOriginal = (mirror: string[], sourceUid: string) => rewrite(mirror, sourceUid, []);

/** Deterministic mirror UID so a re-run never creates a second copy. */
export const mirrorUid = (sourceSide: string, sourceUid: string) =>
  `${sourceUid.replace(/[^A-Za-z0-9@._-]/g, "_")}-mirror-${sourceSide}`;
