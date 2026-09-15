import { beforeEach, describe, expect, it, vi } from "vitest";
import { type CalDavEvent } from "../src/caldav.js";
import { fold, mirrorUid, toMirror, unfold } from "../src/ics.js";
import { parse, syncPair, type Pair } from "../src/sync.js";

const dav = vi.hoisted(() => ({ listEvents: vi.fn(), findByUid: vi.fn(), putEvent: vi.fn(), deleteEvent: vi.fn() }));
vi.mock("../src/caldav.js", async (original) => ({
  ...(await original<typeof import("../src/caldav.js")>()),
  ...dav,
}));

const pair: Pair = {
  name: "example",
  a: { id: "google", url: "https://google.example/cal/", auth: { kind: "basic", user: "u", pass: "p" } },
  b: { id: "icloud", url: "https://icloud.example/cal/", auth: { kind: "basic", user: "u", pass: "p" } },
};
const win = { start: new Date("2024-06-01"), end: new Date("2024-07-01") };
let events: Map<string, CalDavEvent>;
const original = (href: string): CalDavEvent => ({
  href,
  etag: '"1"',
  ics: [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:example",
    "DTSTART:20240620T180000Z",
    "DTEND:20240620T190000Z",
    "SUMMARY:Example",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n"),
});

beforeEach(() => {
  vi.resetAllMocks();
  events = new Map();
  dav.listEvents.mockImplementation(async (_auth, url: string) =>
    [...events.values()].filter((e) => e.href.startsWith(url)),
  );
  dav.findByUid.mockImplementation(
    async (_auth, url: string, uid: string) =>
      [...events.values()].find((e) => e.href.startsWith(url) && parse(e)?.uid === uid) ?? null,
  );
  dav.putEvent.mockImplementation(async (_auth, href: string, ics: string, etag: string | null) => {
    const current = events.get(href);
    if (current ? current.etag !== etag : etag !== null) throw new Error("412 precondition failed");
    events.set(href, { href, ics, etag: '"' + (Number(current?.etag?.replaceAll('"', "") ?? 0) + 1) + '"' });
  });
  dav.deleteEvent.mockImplementation(async (_auth, href: string, etag: string) => {
    if (events.get(href)?.etag !== etag) throw new Error("412 precondition failed");
    events.delete(href);
  });
});

describe("sync execution", () => {
  it.each(["a", "b"] as const)(
    "preserves an original on %s when mirror creation fails, then retries safely",
    async (side) => {
      const src = original(pair[side].url + "example.ics");
      events.set(src.href, src);
      dav.putEvent.mockRejectedValueOnce(new Error("503 unavailable"));
      const failed = await syncPair(pair, win);
      expect(failed.errors).toHaveLength(1);
      expect(events.get(src.href)?.ics).not.toContain("X-SYNC-MIRRORED");
      expect(dav.putEvent).toHaveBeenCalledTimes(1);
      const retried = await syncPair(pair, win);
      expect(retried.errors).toEqual([]);
      expect(retried.created).toBe(1);
      expect(retried.deleted).toBe(0);
      expect(events.size).toBe(2);
      expect(events.get(src.href)?.ics).toContain("X-SYNC-MIRRORED");
    },
  );

  it("propagates a real mirror deletion after successful creation and stamping", async () => {
    const src = original(pair.a.url + "example.ics");
    events.set(src.href, src);
    expect((await syncPair(pair, win)).errors).toEqual([]);
    events.delete(pair.b.url + mirrorUid(pair.a.id, "example") + ".ics");
    const result = await syncPair(pair, win);
    expect(result.deleted).toBe(1);
    expect(events.size).toBe(0);
    expect(dav.findByUid).toHaveBeenCalledWith(pair.b.auth, pair.b.url, mirrorUid(pair.a.id, "example"));
  });

  it("preserves the original when the mirror lookup fails", async () => {
    const src = original(pair.a.url + "example.ics");
    events.set(src.href, src);
    await syncPair(pair, win);
    events.delete(pair.b.url + mirrorUid(pair.a.id, "example") + ".ics");
    dav.findByUid.mockRejectedValueOnce(new Error("503 unavailable"));
    expect((await syncPair(pair, win)).errors).toHaveLength(1);
    expect(events.has(src.href)).toBe(true);
    expect(dav.deleteEvent).not.toHaveBeenCalled();
  });

  it("does not acknowledge a mirror edit when writing it back fails", async () => {
    const src = original(pair.a.url + "example.ics");
    events.set(src.href, src);
    await syncPair(pair, win);
    const href = pair.b.url + mirrorUid(pair.a.id, "example") + ".ics";
    const mirror = events.get(href)!;
    events.set(href, { ...mirror, ics: mirror.ics.replace("SUMMARY:Example", "SUMMARY:Edited") });
    const editedMirror = events.get(href)!.ics;
    dav.putEvent.mockRejectedValueOnce(new Error("412 precondition failed"));
    expect((await syncPair(pair, win)).errors).toHaveLength(1);
    expect(events.get(href)!.ics).toBe(editedMirror);
    expect(events.get(src.href)!.ics).toContain("SUMMARY:Example");
    expect((await syncPair(pair, win)).errors).toEqual([]);
    expect(events.get(src.href)!.ics).toContain("SUMMARY:Edited");
  });

  it("stamps an unstamped original when its matching mirror has an outdated fingerprint", async () => {
    const src = original(pair.a.url + "example.ics");
    events.set(src.href, src);
    const href = pair.b.url + mirrorUid(pair.a.id, "example") + ".ics";
    events.set(href, {
      href,
      etag: '\"1\"',
      ics: fold(
        toMirror(unfold(src.ics.replace("END:VEVENT", "LAST-MODIFIED:20240621T000000Z\r\nEND:VEVENT")), {
          uid: mirrorUid(pair.a.id, "example"),
          sourceSide: pair.a.id,
          sourceUid: "example",
          fp: "outdated",
        }),
      ),
    });
    expect((await syncPair(pair, win)).errors).toEqual([]);
    expect(events.get(src.href)!.ics).toContain("X-SYNC-MIRRORED:icloud");
    expect((await syncPair(pair, win)).updated).toBe(0);
  });

  it("migrates an unstamped original and applies a pending mirror edit with one conditional write", async () => {
    const src = original(pair.a.url + "example.ics");
    const parsed = parse(src)!;
    const mirror = {
      href: pair.b.url + mirrorUid(pair.a.id, "example") + ".ics",
      etag: '"1"',
      ics: fold(
        toMirror(unfold(src.ics), {
          uid: mirrorUid(pair.a.id, "example"),
          sourceSide: pair.a.id,
          sourceUid: "example",
          fp: parsed.fp,
        }),
      ).replace("SUMMARY:Example", "SUMMARY:Edited"),
    };
    events.set(src.href, src);
    events.set(mirror.href, mirror);
    const result = await syncPair(pair, win);
    expect(result.errors).toEqual([]);
    expect(events.get(src.href)?.ics).toContain("SUMMARY:Edited");
    expect(events.get(src.href)?.ics).toContain("X-SYNC-MIRRORED:icloud");
    expect((await syncPair(pair, win)).updated).toBe(0);
  });
});
