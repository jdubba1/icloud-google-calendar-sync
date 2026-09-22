import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { reviewDuplicates, reviewEvents } from "../src/dedupe.js";
import type { JevComparison } from "../src/jev.js";
import type { CalDavEvent } from "../src/caldav.js";

const range = { start: new Date("2026-09-01Z"), end: new Date("2026-10-01Z") };
const pairs = ["shared", "personal"].map((name) => ({
  name,
  a: `icloud:https://calendar.example/${name}/a/`,
  b: `icloud:https://calendar.example/${name}/b/`,
}));
const rule = { prefer: "shared", over: ["personal"], mode: "review" };
const dedupe = { provider: "gateway", apiKey: "env:KEY", rules: [rule] };
const config = () => loadConfig({ icloud: { username: "u", appPassword: "p" }, pairs, dedupe }, { KEY: "test-key" });
const event = (uid: string, extra = "", start = "20260923T170000Z", end = "20260923T180000Z") =>
  `BEGIN:VEVENT\nUID:${uid}\nSUMMARY:Hotel booking\nDTSTART:${start}\nDTEND:${end}\n${extra}\nEND:VEVENT`;
const resource = (ics: string, href = "https://calendar.example/event.ics"): CalDavEvent => ({
  href,
  etag: '"1"',
  ics: `BEGIN:VCALENDAR\n${ics}\nEND:VCALENDAR`,
});
const match: JevComparison = {
  status: "classified",
  probability: 0.99,
  suggestedDuplicate: true,
};

describe("priority config", () => {
  it("resolves keys and supports file and env configuration", () => {
    expect(config().dedupe).toEqual({ ...dedupe, apiKey: "test-key", maxComparisons: 100, threshold: 0.95 });
    expect(
      loadConfig({ pairs }, { CALENDAR_DEDUPE: JSON.stringify({ ...dedupe, provider: "typesafe" }), KEY: "direct-key" })
        .dedupe?.apiKey,
    ).toBe("direct-key");
    expect(loadConfig({ pairs }, {}).dedupe).toBeUndefined();
  });
  it.each([
    null,
    [],
    { ...dedupe, provider: "unknown" },
    { ...dedupe, apiKey: "env:MISSING" },
    { ...dedupe, rules: [] },
    { ...dedupe, maxComparisons: 0 },
    { ...dedupe, rules: [{ ...rule, mode: "invalid" }] },
    { ...dedupe, rules: [{ ...rule, prefer: "missing" }] },
    { ...dedupe, rules: [{ ...rule, over: ["missing"] }] },
    { ...dedupe, rules: [{ ...rule, over: ["shared"] }] },
    { ...dedupe, rules: [{ ...rule, over: ["personal", "personal"] }] },
    { ...dedupe, rules: [rule, { prefer: "personal", over: ["shared"], mode: "review" }] },
  ])("rejects invalid or conflicting priorities %#", (raw) => {
    expect(() => loadConfig({ pairs, dedupe: raw }, { KEY: "test-key" })).toThrow();
  });
  it.each([0, 0.8, 1])("reads threshold %s from file and environment", (threshold) => {
    expect(loadConfig({ pairs, dedupe: { ...dedupe, threshold } }, { KEY: "key" }).dedupe?.threshold).toBe(threshold);
    expect(
      loadConfig({ pairs }, { KEY: "key", CALENDAR_DEDUPE: JSON.stringify({ ...dedupe, threshold }) }).dedupe
        ?.threshold,
    ).toBe(threshold);
  });
  it.each([-0.1, 1.1, NaN, Infinity, "0.9", null])("rejects invalid threshold %s", (threshold) => {
    expect(() => loadConfig({ pairs, dedupe: { ...dedupe, threshold } }, { KEY: "key" })).toThrow(/threshold/);
  });
  it("rejects ambiguous pair names", () => {
    expect(() => loadConfig({ pairs: [pairs[0], pairs[0]], dedupe }, { KEY: "test" })).toThrow(/unique/);
  });
});

describe("occurrence parsing", () => {
  it("reads expanded instances and ignores alarm properties, mirrors, and cancellations", () => {
    const data = [
      resource(
        [
          event("series", "RECURRENCE-ID:20260923T170000Z\nBEGIN:VALARM\nSUMMARY:Alarm title\nEND:VALARM"),
          event("series", "RECURRENCE-ID:20260924T170000Z", "20260924T170000Z", "20260924T180000Z"),
          event("mirror", "X-SYNC-SOURCE:google:original"),
          event("cancelled", "STATUS:CANCELLED"),
        ].join("\n"),
      ),
    ];
    const result = reviewEvents(data, "shared", "icloud", range);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({ title: "Hotel booking", recurrenceId: "20260923T170000Z" });
    expect(result.skipped).toBe(0);
  });
  it("skips unexpanded recurrences, ambiguous dates, and oversized text", () => {
    const data = [
      event("recurring", "RRULE:FREQ=DAILY"),
      event("floating", "", "20260923T170000", "20260923T180000"),
      event("bad", "", "20260931T170000Z", "20260931T180000Z"),
      event("long").replace("Hotel booking", "x".repeat(501)),
      event("outside", "", "20270101T170000Z", "20270101T180000Z"),
    ];
    const result = reviewEvents(
      data.map((s) => resource(s)),
      "shared",
      "icloud",
      range,
    );
    expect(result.events).toEqual([]);
    expect(result.skipped).toBe(4);
  });
  it("parses all-day dates, single days, time zones, and escaped text", () => {
    const data = [
      event("days", "LOCATION:Hotel\\, downtown", "20260923", "20260925"),
      event("day", "", "20260923", "20260924").replace("DTEND:20260924\n", ""),
      event("tz").replace("DTSTART:20260923T170000Z", "DTSTART;TZID=America/Chicago:20260923T120000"),
    ];
    const result = reviewEvents(
      data.map((s) => resource(s)),
      "shared",
      "icloud",
      range,
    );
    expect(result.events).toHaveLength(3);
    expect(result.events[0]).toMatchObject({ allDay: true, location: "Hotel, downtown" });
    expect(result.events[1].end - result.events[1].start).toBe(86400000);
    expect(result.events[2].start).toBe(Date.parse("2026-09-23T17:00Z"));
  });
});

describe("review runner", () => {
  const list = () =>
    vi.fn(async (_auth, url: string) => [
      resource(event(url, url.includes("/b/") ? "X-SYNC-SOURCE:icloud:original" : ""), url + "event.ics"),
    ]);
  it("compares originals from the configured groups and recommends the priority calendar", async () => {
    const read = list();
    const compare = vi.fn(async () => match);
    const report = await reviewDuplicates(config(), { range, list: read, compare });
    expect(read).toHaveBeenCalledTimes(4);
    expect(compare).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({ mode: "review", comparisons: 1, errors: [], unavailable: 0, truncated: false });
    expect(report.suggestions[0]).toMatchObject({
      keep: { pair: "shared" },
      duplicate: { pair: "personal" },
      probability: 0.99,
    });
  });
  it("does not suggest low-probability or unavailable results", async () => {
    for (const result of [
      { ...match, probability: 0.5, suggestedDuplicate: false },
      { status: "unavailable" } as const,
    ]) {
      const report = await reviewDuplicates(config(), { range, list: list(), compare: async () => result });
      expect(report.suggestions).toEqual([]);
      expect(report.unavailable).toBe(result.status === "unavailable" ? 1 : 0);
    }
  });
  it.each([0.8, 0.9])("applies configured threshold %s even with a custom matcher", async (threshold) => {
    const cfg = config();
    cfg.dedupe!.threshold = threshold;
    const report = await reviewDuplicates(cfg, {
      range,
      list: list(),
      compare: async () => ({ status: "classified", probability: 0.8, suggestedDuplicate: threshold === 0.9 }),
    });
    expect(report.suggestions).toHaveLength(threshold === 0.8 ? 1 : 0);
  });
  it("bounds comparisons and reports truncation", async () => {
    const cfg = config();
    cfg.dedupe!.maxComparisons = 1;
    const read = vi.fn(async (_auth, url: string) => [resource(event(url), url + "event.ics")]);
    const compare = vi.fn(async () => match);
    const report = await reviewDuplicates(cfg, { range, list: read, compare });
    expect(report.truncated).toBe(true);
    expect(compare).toHaveBeenCalledTimes(1);
  });
  it("reports calendar read failures without exposing response bodies or keys", async () => {
    const report = await reviewDuplicates(config(), {
      range,
      list: async () => {
        throw new Error("test-key secret-body");
      },
      compare: async () => match,
    });
    expect(report.errors).toHaveLength(4);
    expect(JSON.stringify(report)).not.toMatch(/test-key|secret-body/);
    expect(report.comparisons).toBe(0);
  });
  it("will not scan without explicit dedupe config", async () => {
    const cfg = config();
    delete cfg.dedupe;
    const read = list();
    await expect(reviewDuplicates(cfg, { list: read })).rejects.toThrow(/Configure dedupe/);
    expect(read).not.toHaveBeenCalled();
  });
});

it("runs calendar reads through Gateway without any calendar writes or extra event data", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.startsWith("https://calendar.example/")) {
      expect(init?.method).toBe("REPORT");
      expect(String(init?.body)).toContain("<c:expand");
      const extra = url.includes("/b/")
        ? "X-SYNC-SOURCE:icloud:original"
        : "DESCRIPTION:private-notes\nATTENDEE:mailto:private@example.com";
      return new Response(
        `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>${url}event.ics</d:href><d:propstat><d:prop><d:getetag>"1"</d:getetag><c:calendar-data><![CDATA[${resource(event(url, extra)).ics}]]></c:calendar-data></d:prop></d:propstat></d:response></d:multistatus>`,
        { status: 207 },
      );
    }
    expect(url).toBe("https://ai-gateway.vercel.sh/v4/ai/evaluation-model");
    expect(init?.method).toBe("POST");
    expect(String(init?.body)).not.toMatch(/private-notes|private@example|calendar.example/);
    return Response.json({
      answers: {
        match: {
          type: "boolean",
          probability: 0.99,
        },
      },
    });
  });
  vi.stubGlobal("fetch", fetch);
  try {
    const report = await reviewDuplicates(config(), { range });
    expect(report.suggestions).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(report.errors).toEqual([]);
  } finally {
    vi.unstubAllGlobals();
  }
});
