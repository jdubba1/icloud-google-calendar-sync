import { beforeEach, expect, it, vi } from "vitest";
import { consolidateDuplicates } from "../src/consolidate.js";
import { loadConfig, pairsFor } from "../src/config.js";
import { fold, unfold, fingerprint, mirrorUid, toMirror } from "../src/ics.js";
import { CalDavError, type CalDavEvent } from "../src/caldav.js";

const state = vi.hoisted(() => ({ resources: new Map<string, CalDavEvent>(), deletes: [] as string[], fail: "" }));
vi.mock("../src/caldav.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/caldav.js")>()),
  dav: vi.fn(async (_auth, _method, href) => {
    const resource = state.resources.get(href);
    if (!resource) throw new CalDavError(404, "GET", href, "");
    return { status: 200, text: resource.ics, headers: new Headers({ etag: resource.etag! }) };
  }),
  listEvents: vi.fn(async (_auth, url) => [...state.resources.values()].filter((r) => r.href.startsWith(url))),
  deleteEvent: vi.fn(async (_auth, href, etag) => {
    if (state.fail === href || state.resources.get(href)?.etag !== etag) throw new Error("write failed");
    state.deletes.push(href);
    state.resources.delete(href);
  }),
}));
const range = { start: new Date("2026-09-01Z"), end: new Date("2026-10-01Z") };
const config = () =>
  loadConfig(
    {
      google: { clientId: "id", clientSecret: "secret", refreshToken: "token" },
      icloud: { username: "u", appPassword: "p" },
      pairs: ["shared", "personal"].map((name) => ({
        name,
        a: `google:${name}`,
        b: `icloud:https://calendar.example/${name}/`,
      })),
      dedupe: { provider: "gateway", apiKey: "key", rules: [{ prefer: "shared", over: ["personal"], mode: "delete" }] },
    },
    {},
  );
function fixture() {
  const cfg = config(),
    pairs = pairsFor(cfg);
  const resource = (href: string, uid: string): CalDavEvent => ({
    href,
    etag: '"1"',
    ics: `BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:${uid}\nSUMMARY:Hotel\nDTSTART:20260923T170000Z\nDTEND:20260923T180000Z\nEND:VEVENT\nEND:VCALENDAR`,
  });
  const keep = resource(pairs[0].a.url + "keep.ics", "keep");
  const drop = resource(pairs[1].a.url + "drop.ics", "drop");
  const lines = unfold(drop.ics),
    uid = mirrorUid("google", "drop");
  const mirror = {
    href: pairs[1].b.url + encodeURIComponent(uid) + ".ics",
    etag: '"1"',
    ics: fold(toMirror(lines, { uid, sourceSide: "google", sourceUid: "drop", fp: fingerprint(lines) })),
  };
  for (const r of [keep, drop, mirror]) state.resources.set(r.href, r);
  const options = {
    range,
    list: vi.fn(async (_auth: unknown, url: string) =>
      [...state.resources.values()].filter((r) => r.href.startsWith(url)),
    ),
    compare: vi.fn(async () => ({ status: "classified" as const, probability: 0.96, suggestedDuplicate: true })),
  };
  return { cfg, keep, drop, mirror, options };
}
beforeEach(() => {
  state.resources.clear();
  state.deletes.length = 0;
  state.fail = "";
});
it("deletes mirror first, verifies removal, keeps winner, and supplies recovery copies", async () => {
  const { cfg, keep, drop, mirror, options } = fixture();
  const onDelete = vi.fn();
  const result = await consolidateDuplicates(cfg, { ...options, onDelete });
  expect(state.deletes).toEqual([mirror.href, drop.href]);
  expect(state.resources.get(keep.href)).toEqual(keep);
  expect(result.results[0]).toMatchObject({ status: "deleted", deletedCopies: 2 });
  expect(onDelete.mock.calls.map((c) => c[0].phase)).toEqual(["before", "completed"]);
  expect(onDelete.mock.calls[0][0].resources).toHaveLength(2);
});
it("can retry after mirror deletion without a journal", async () => {
  const { cfg, drop, mirror, options } = fixture();
  state.fail = drop.href;
  expect((await consolidateDuplicates(cfg, options)).results[0]).toMatchObject({ status: "failed", deletedCopies: 1 });
  expect(state.resources.has(drop.href)).toBe(true);
  expect(state.resources.has(mirror.href)).toBe(false);
  state.fail = "";
  expect((await consolidateDuplicates(cfg, options)).results[0]).toMatchObject({ status: "deleted", deletedCopies: 1 });
  expect((await consolidateDuplicates(cfg, options)).results).toEqual([]);
});
it.each(["RRULE:FREQ=DAILY", "ATTENDEE:mailto:guest@example.com", "ORGANIZER:mailto:owner@example.com"])(
  "skips unsupported resources: %s",
  async (extra) => {
    const { cfg, drop, options } = fixture();
    drop.ics = drop.ics.replace("END:VEVENT", extra + "\nEND:VEVENT");
    await consolidateDuplicates(cfg, options);
    expect(state.deletes).toEqual([]);
  },
);
it("aborts before deletion when a backup hook fails", async () => {
  const { cfg, options } = fixture();
  await consolidateDuplicates(cfg, {
    ...options,
    onDelete: () => {
      throw new Error("backup unavailable");
    },
  });
  expect(state.deletes).toEqual([]);
});
it("does not delete after an event edit during the hook", async () => {
  const { cfg, drop, options } = fixture();
  await consolidateDuplicates(cfg, {
    ...options,
    onDelete: () => {
      drop.etag = '"2"';
    },
  });
  expect(state.deletes).toEqual([]);
});
it("skips independently edited mirrors", async () => {
  const { cfg, mirror, options } = fixture();
  mirror.ics = mirror.ics.replace("SUMMARY:Hotel", "SUMMARY:Edited");
  await consolidateDuplicates(cfg, options);
  expect(state.deletes).toEqual([]);
});
it("review mode and incomplete model results never delete", async () => {
  const { cfg, options } = fixture();
  cfg.dedupe!.rules[0].mode = "review";
  await consolidateDuplicates(cfg, options);
  cfg.dedupe!.rules[0].mode = "delete";
  await consolidateDuplicates(cfg, { ...options, compare: async () => ({ status: "unavailable" }) });
  expect(state.deletes).toEqual([]);
});
it("does not delete below threshold", async () => {
  const { cfg, options } = fixture();
  cfg.dedupe!.threshold = 0.99;
  await consolidateDuplicates(cfg, options);
  expect(state.deletes).toEqual([]);
});
it("reports completion hook failure without misreporting completed deletes", async () => {
  const { cfg, options } = fixture();
  const result = await consolidateDuplicates(cfg, {
    ...options,
    onDelete: (notice) => {
      if (notice.phase === "completed") throw new Error("offline");
    },
  });
  expect(result.results[0]).toMatchObject({
    status: "deleted",
    reason: "Completion hook failed after verified deletion",
  });
});
it("rejects propagation mode before any IO", async () => {
  const { cfg, options } = fixture();
  cfg.pairs[1].propagateDeletes = true;
  await expect(consolidateDuplicates(cfg, options)).rejects.toThrow(/propagateDeletes/);
  expect(options.list).not.toHaveBeenCalled();
});
it("the default rule remains review", () => {
  const cfg = config();
  const { mode: _mode, ...rule } = cfg.dedupe!.rules[0];
  expect(loadConfig({ ...cfg, dedupe: { ...cfg.dedupe, rules: [rule] } }, {}).dedupe!.rules[0].mode).toBe("review");
});
