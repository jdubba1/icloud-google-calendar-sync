import { afterEach, describe, expect, it, vi } from "vitest";
import { findByUid } from "../src/caldav.js";

const auth = { kind: "basic", user: "u", pass: "p" } as const;
const calendar = "https://calendar.example/events/";
const response = (uid: string, index: number) => `
  <d:response><d:href>/events/${index}.ics</d:href><d:propstat><d:prop>
  <d:getetag>"1"</d:getetag><c:calendar-data><![CDATA[BEGIN:VCALENDAR
BEGIN:VEVENT
UID:${uid}
DTSTART:20200101T120000Z
END:VEVENT
END:VCALENDAR]]></c:calendar-data>
  </d:prop></d:propstat></d:response>`;

afterEach(() => vi.unstubAllGlobals());

describe("findByUid", () => {
  it.each([
    { name: "unrelated events only", uids: ["unrelated", "wanted-mirror-google"], match: null },
    { name: "exact match after unrelated events", uids: ["unrelated", "wanted"], match: 1 },
    { name: "folded UID outside the sync window", uids: ["unrelated", "wan\r\n ted"], match: 1 },
    { name: "no events", uids: [], match: null },
  ])("handles $name", async ({ uids, match }) => {
    // Google may ignore the UID filter and return unrelated calendar resources.
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${uids
              .map(response)
              .join("")}</d:multistatus>`,
            { status: 207 },
          ),
        ),
    );
    const event = await findByUid(auth, calendar, "wanted");
    expect(event?.href ?? null).toBe(match === null ? null : `${calendar}${match}.ics`);
  });

  it("throws on lookup failure instead of treating the event as absent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })));
    await expect(findByUid(auth, calendar, "wanted")).rejects.toThrow("503");
  });
});

it("requests expanded occurrences only for review", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('<d:multistatus xmlns:d="DAV:"/>', { status: 207 }));
  vi.stubGlobal("fetch", fetch);
  const { listOccurrences } = await import("../src/caldav.js");
  await listOccurrences(auth, calendar, { start: new Date("2026-09-01Z"), end: new Date("2026-10-01Z") });
  expect(fetch.mock.calls[0][1].method).toBe("REPORT");
  expect(fetch.mock.calls[0][1].body).toContain('<c:expand start="20260901T000000Z" end="20261001T000000Z"/>');
});
