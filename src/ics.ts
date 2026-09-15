// Minimal iCalendar handling for calendar mirroring. No parser dependency:
// we never interpret a calendar, we transport it. A mirror is the source's
// VCALENDAR text with the UID rewritten, every ATTENDEE/ORGANIZER stripped
// (a mirror must never be an invitation — see the 2026-09-14 iCloud
// accept-loop), and two X-SYNC-* lines added so a later run can recognise it.
//
// Line folding (RFC 5545 §3.1) is undone before any inspection and redone on
// output, so property matching is by whole logical line.

export const X_SOURCE = "X-SYNC-SOURCE";
export const X_FP = "X-SYNC-FP";

/** Unfold RFC 5545 continuation lines and normalise line endings. */
export function unfold(ics: string): string[] {
  const out: string[] = [];
  for (const raw of ics.split(/\r?\n/)) {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && out.length) {
      out[out.length - 1] += raw.slice(1);
    } else if (raw.length) {
      out.push(raw);
    }
  }
  return out;
}

/** Fold logical lines at 75 octets, CRLF terminated. */
export function fold(lines: string[]): string {
  const enc = new TextEncoder();
  const parts: string[] = [];
  for (const line of lines) {
    if (enc.encode(line).length <= 75) {
      parts.push(line);
      continue;
    }
    let cur = "";
    let first = true;
    for (const ch of line) {
      const limit = first ? 75 : 74;
      if (enc.encode(cur + ch).length > limit) {
        parts.push(first ? cur : " " + cur);
        cur = ch;
        first = false;
      } else {
        cur += ch;
      }
    }
    parts.push(first ? cur : " " + cur);
  }
  return parts.join("\r\n") + "\r\n";
}

/** Property name of a logical line ("DTSTART;TZID=..." → "DTSTART"). */
export function propName(line: string): string {
  const m = /^([A-Za-z0-9-]+)/.exec(line);
  return m ? m[1].toUpperCase() : "";
}

export function propValue(line: string): string {
  const i = line.indexOf(":");
  return i < 0 ? "" : line.slice(i + 1);
}

/** Value of the first occurrence of a property inside the first VEVENT. */
export function eventProp(lines: string[], name: string): string | null {
  let inEvent = false;
  for (const l of lines) {
    if (l === "BEGIN:VEVENT") inEvent = true;
    else if (l === "END:VEVENT") inEvent = false;
    else if (inEvent && propName(l) === name) return propValue(l);
  }
  return null;
}

export const uidOf = (lines: string[]): string | null => eventProp(lines, "UID");

/** `X-SYNC-SOURCE:<side>:<uid>` on a mirror, or null on an original. */
export function sourceRef(lines: string[]): { side: string; uid: string } | null {
  const v = eventProp(lines, X_SOURCE);
  if (!v) return null;
  const i = v.indexOf(":");
  return i < 0 ? null : { side: v.slice(0, i), uid: v.slice(i + 1) };
}

/** RFC 5545 UTC stamp → epoch ms; null if absent/unparseable. */
export function stampToMs(v: string | null): number | null {
  if (!v) return null;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(v.trim());
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

export function lastModifiedMs(lines: string[]): number {
  return stampToMs(eventProp(lines, "LAST-MODIFIED")) ?? stampToMs(eventProp(lines, "DTSTAMP")) ?? 0;
}

// --- fingerprint -----------------------------------------------------------
// What a human would call "the event": when, what, where, how often. Servers
// rewrite PRODID, DTSTAMP, SEQUENCE and VTIMEZONE freely; those are excluded
// so a round trip through a server does not read as an edit.

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

/** Offset of an IANA zone at an instant, in minutes east of UTC. */
function zoneOffsetMin(tz: string, utcMs: number): number | null {
  try {
    const f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const p: Record<string, number> = {};
    for (const part of f.formatToParts(new Date(utcMs))) {
      if (part.type !== "literal") p[part.type] = Number(part.value);
    }
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return Math.round((asUtc - utcMs) / 60_000);
  } catch {
    return null;
  }
}

/** Normalise a date/date-time property to a comparable string. */
export function normalizeDateLine(line: string): string {
  const name = propName(line);
  const value = propValue(line).trim();
  const tzm = /;TZID=([^;:]+)/i.exec(line);
  const tz = tzm ? tzm[1].replace(/^"|"$/g, "") : null;
  if (/^\d{8}$/.test(value)) return `${name}=D${value}`;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!m) return `${name}=${value}`;
  const local = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (m[7] === "Z") return `${name}=${local}`;
  if (!tz) return `${name}=${local}F`; // floating time: no zone to resolve
  const off = zoneOffsetMin(tz, local);
  return off == null ? `${name}=${value}@${tz}` : `${name}=${local - off * 60_000}`;
}

function normalizeText(v: string): string {
  return v
    .replace(/\\n/g, "\n")
    .replace(/\\([,;\\])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Stable fingerprint of the human-visible content of every VEVENT in the file. */
export function fingerprint(lines: string[]): string {
  const sig: string[] = [];
  let inEvent = false;
  let inAlarm = false;
  for (const l of lines) {
    if (l === "BEGIN:VEVENT") {
      inEvent = true;
      sig.push("|");
      continue;
    }
    if (l === "END:VEVENT") {
      inEvent = false;
      continue;
    }
    if (l === "BEGIN:VALARM") inAlarm = true;
    if (l === "END:VALARM") inAlarm = false;
    if (!inEvent || inAlarm) continue;
    const name = propName(l);
    if (!FP_PROPS.has(name)) continue;
    if (name === "DTSTART" || name === "DTEND" || name === "RECURRENCE-ID") {
      sig.push(normalizeDateLine(l));
      continue;
    }
    const value = normalizeText(propValue(l));
    // Google pads stored events with empty DESCRIPTION/LOCATION and the
    // spec defaults STATUS:CONFIRMED / TRANSP:OPAQUE; absent and default
    // must fingerprint alike or every Google-side mirror reads as edited.
    if (value === "") continue;
    if (name === "STATUS" && value === "CONFIRMED") continue;
    if (name === "TRANSP" && value === "OPAQUE") continue;
    sig.push(`${name}=${value}`);
  }
  return hash([...sig].sort().join("\n"));
}

function hash(s: string): string {
  // FNV-1a 32-bit, twice with different seeds — plenty for change detection.
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x811c9dc5) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

// --- mirror construction ---------------------------------------------------

const STRIP = new Set(["ATTENDEE", "ORGANIZER", X_SOURCE, X_FP]);

/**
 * Build the mirror of `sourceLines` for the other side. Every VEVENT (master
 * and recurrence exceptions) gets `uid`, loses attendees/organizer, and gains
 * the sync markers. Everything else — timezones, alarms, recurrence — is
 * carried verbatim.
 */
export function toMirror(
  sourceLines: string[],
  opts: { uid: string; sourceSide: string; sourceUid: string; fp: string },
): string[] {
  const out: string[] = [];
  let inEvent = false;
  for (const l of sourceLines) {
    const name = propName(l);
    if (l === "BEGIN:VEVENT") {
      inEvent = true;
      out.push(l);
      continue;
    }
    if (l === "END:VEVENT") {
      inEvent = false;
      out.push(`${X_SOURCE}:${opts.sourceSide}:${opts.sourceUid}`);
      out.push(`${X_FP}:${opts.fp}`);
      out.push(l);
      continue;
    }
    if (inEvent && name === "UID") {
      out.push(`UID:${opts.uid}`);
      continue;
    }
    if (inEvent && STRIP.has(name)) continue;
    out.push(l);
  }
  return out;
}

/**
 * Take an edited mirror and rebuild the original: restore the source UID and
 * drop the sync markers, leaving the human's edits in place.
 */
export function toOriginal(mirrorLines: string[], sourceUid: string): string[] {
  const out: string[] = [];
  let inEvent = false;
  for (const l of mirrorLines) {
    const name = propName(l);
    if (l === "BEGIN:VEVENT") inEvent = true;
    if (l === "END:VEVENT") inEvent = false;
    if (inEvent && name === "UID") {
      out.push(`UID:${sourceUid}`);
      continue;
    }
    if (inEvent && STRIP.has(name)) continue;
    out.push(l);
  }
  return out;
}

/** Deterministic mirror UID so a re-run never creates a second copy. */
export const mirrorUid = (sourceSide: string, sourceUid: string): string =>
  `${sourceUid.replace(/[^A-Za-z0-9@._-]/g, "_")}-mirror-${sourceSide}`;
