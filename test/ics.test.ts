import { describe, expect, it } from "vitest";
import {
  eventProp,
  fingerprint,
  fold,
  mirrorUid,
  sourceRef,
  toMirror,
  toOriginal,
  uidOf,
  unfold,
  X_FP,
  X_SOURCE,
} from "../src/ics.js";

const GOOGLE_FLIGHT = [
  "BEGIN:VCALENDAR",
  "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
  "VERSION:2.0",
  "BEGIN:VTIMEZONE",
  "TZID:America/Chicago",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "DTSTART;TZID=America/Chicago:20260924T193500",
  "DTEND;TZID=America/Chicago:20260924T232500",
  "DTSTAMP:20260911T120000Z",
  "UID:abc123@google.com",
  "ORGANIZER;CN=James:mailto:james@example.com",
  "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Partner;X-NUM-GUESTS=0:mailto:partner@",
  " gmail.com",
  "LAST-MODIFIED:20260911T120000Z",
  "SUMMARY:Flight to San Francisco (UA 292)",
  "LOCATION:Austin AUS",
  "BEGIN:VALARM",
  "TRIGGER:-PT30M",
  "ACTION:DISPLAY",
  "END:VALARM",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("unfold/fold", () => {
  it("joins continuation lines and folds back under 75 octets", () => {
    const lines = unfold(GOOGLE_FLIGHT);
    expect(lines.find((l) => l.startsWith("ATTENDEE"))).toContain("mailto:partner@example.com");
    const long = "DESCRIPTION:" + "x".repeat(200);
    const folded = fold([long]);
    for (const l of folded.split("\r\n")) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
    expect(unfold(folded)[0]).toBe(long);
  });
});

describe("toMirror", () => {
  const lines = unfold(GOOGLE_FLIGHT);
  const mirror = toMirror(lines, {
    uid: "m-1",
    sourceSide: "google",
    sourceUid: "abc123@google.com",
    fp: "deadbeef",
  });

  it("rewrites the UID and strips every attendee and organizer", () => {
    expect(uidOf(mirror)).toBe("m-1");
    expect(mirror.some((l) => l.startsWith("ATTENDEE"))).toBe(false);
    expect(mirror.some((l) => l.startsWith("ORGANIZER"))).toBe(false);
  });

  it("stamps the source and fingerprint markers", () => {
    expect(sourceRef(mirror)).toEqual({ side: "google", uid: "abc123@google.com" });
    expect(eventProp(mirror, X_FP)).toBe("deadbeef");
  });

  it("keeps timezone, alarm, summary and location verbatim", () => {
    expect(mirror).toContain("TZID:America/Chicago");
    expect(mirror).toContain("TRIGGER:-PT30M");
    expect(mirror).toContain("SUMMARY:Flight to San Francisco (UA 292)");
    expect(mirror).toContain("LOCATION:Austin AUS");
  });

  it("round-trips back to an original with the source UID and no markers", () => {
    const back = toOriginal(mirror, "abc123@google.com");
    expect(uidOf(back)).toBe("abc123@google.com");
    expect(back.some((l) => l.startsWith(X_SOURCE) || l.startsWith(X_FP))).toBe(false);
  });

  it("mirror UID is deterministic and safe", () => {
    expect(mirrorUid("google", "abc123@google.com")).toBe("abc123@google.com-mirror-google");
    expect(mirrorUid("icloud", "we!rd uid")).toBe("we_rd_uid-mirror-icloud");
  });
});

describe("fingerprint", () => {
  const base = unfold(GOOGLE_FLIGHT);
  it("ignores server-rewritten noise", () => {
    const noisy = base.map((l) =>
      l.startsWith("DTSTAMP") ? "DTSTAMP:20260912T000000Z" : l.startsWith("PRODID") ? "PRODID:-//Apple//EN" : l,
    );
    noisy.splice(noisy.indexOf("END:VEVENT"), 0, "SEQUENCE:3");
    expect(fingerprint(noisy)).toBe(fingerprint(base));
  });
  it("ignores attendees and sync markers, so a mirror fingerprints like its source", () => {
    const mirror = toMirror(base, { uid: "m", sourceSide: "google", sourceUid: "abc", fp: "x" });
    expect(fingerprint(mirror)).toBe(fingerprint(base));
  });
  it("changes when a human would notice", () => {
    const moved = base.map((l) => (l.startsWith("DTSTART") ? "DTSTART;TZID=America/Chicago:20260924T200000" : l));
    expect(fingerprint(moved)).not.toBe(fingerprint(base));
    const renamed = base.map((l) => (l.startsWith("SUMMARY") ? "SUMMARY:Flight to SF" : l));
    expect(fingerprint(renamed)).not.toBe(fingerprint(base));
  });
  it("ignores Google's padding: empty DESCRIPTION/LOCATION and default STATUS/TRANSP", () => {
    const apple = unfold(
      [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "UID:a",
        "DTSTART;VALUE=DATE:20260923",
        "DTEND;VALUE=DATE:20260925",
        "SUMMARY:San Antonio",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
    );
    const google = unfold(
      [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "UID:a-mirror-icloud",
        "DTSTART;VALUE=DATE:20260923",
        "DTEND;VALUE=DATE:20260925",
        "DESCRIPTION:",
        "LOCATION:",
        "SEQUENCE:1",
        "STATUS:CONFIRMED",
        "SUMMARY:San Antonio",
        "TRANSP:OPAQUE",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
    );
    expect(fingerprint(google)).toBe(fingerprint(apple));
    const cancelled = google.map((l) => (l === "STATUS:CONFIRMED" ? "STATUS:CANCELLED" : l));
    expect(fingerprint(cancelled)).not.toBe(fingerprint(apple));
  });
  it("treats the same instant in UTC and in a zone as equal", () => {
    const utc = base.map((l) =>
      l.startsWith("DTSTART") ? "DTSTART:20260925T003500Z" : l.startsWith("DTEND") ? "DTEND:20260925T042500Z" : l,
    );
    expect(fingerprint(utc)).toBe(fingerprint(base));
  });
});
