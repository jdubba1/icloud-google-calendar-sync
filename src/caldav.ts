// A CalDAV client small enough to read in one sitting. iCloud uses Basic with
// an app-specific password; Google's CalDAV v2 uses Bearer. Responses are
// fixed shapes, picked apart with regexes (no DOM parser in most runtimes).

import { uidOf, unfold } from "./ics.js";

export type CalDavAuth =
  { kind: "basic"; user: string; pass: string } | { kind: "bearer"; token: () => Promise<string> };
export type CalDavEvent = { href: string; etag: string | null; ics: string };
export type CalendarInfo = { href: string; name: string; components: string[]; shared: boolean };

const NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/"';
const XML = { "Content-Type": "application/xml" };

export class CalDavError extends Error {
  constructor(
    readonly status: number,
    method: string,
    url: string,
    body: string,
  ) {
    super(`${method} ${url} → ${status}: ${body.slice(0, 300)}`);
  }
}

export async function dav(
  auth: CalDavAuth,
  method: string,
  url: string,
  init: { body?: string; headers?: Record<string, string> } = {},
) {
  const Authorization =
    auth.kind === "basic"
      ? "Basic " + Buffer.from(`${auth.user}:${auth.pass}`).toString("base64")
      : "Bearer " + (await auth.token());
  const res = await fetch(url, {
    method,
    body: init.body,
    cache: "no-store",
    headers: { Authorization, "User-Agent": "icloud-google-calendar-sync/0.1", ...init.headers },
  });
  const text = await res.text();
  if (res.status >= 400) throw new CalDavError(res.status, method, url, text);
  return { status: res.status, text, headers: res.headers };
}

/** Unescape XML text (calendar-data arrives entity-escaped or in CDATA). */
export function xmlText(s: string): string {
  const raw = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s)?.[1] ?? s;
  return raw
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

const tag = (xml: string, local: string): string | null =>
  new RegExp(`<(?:[\\w-]+:)?${local}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${local}>`, "i").exec(xml)?.[1] ?? null;

export const responses = (xml: string): string[] =>
  [...xml.matchAll(/<(?:[\w-]+:)?response(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi)].map((m) => m[1]);

const resolveHref = (base: string, href: string) => new URL(xmlText(href.trim()), base).toString();
const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function propfind(auth: CalDavAuth, url: string, depth: 0 | 1, props: string): Promise<string> {
  return (
    await dav(auth, "PROPFIND", url, {
      headers: { Depth: String(depth), ...XML },
      body: `<d:propfind ${NS}><d:prop>${props}</d:prop></d:propfind>`,
    })
  ).text;
}

// --- discovery (once, from the CLI) ------------------------------------------

export async function currentUserPrincipal(auth: CalDavAuth, base: string): Promise<string> {
  const href = tag(
    tag(await propfind(auth, base, 0, "<d:current-user-principal/>"), "current-user-principal") ?? "",
    "href",
  );
  if (!href) throw new Error("no current-user-principal at " + base);
  return resolveHref(base, href);
}

export async function calendarHome(auth: CalDavAuth, principal: string): Promise<string> {
  const href = tag(
    tag(await propfind(auth, principal, 0, "<c:calendar-home-set/>"), "calendar-home-set") ?? "",
    "href",
  );
  if (!href) throw new Error("no calendar-home-set at " + principal);
  return resolveHref(principal, href);
}

export async function listCalendars(auth: CalDavAuth, home: string): Promise<CalendarInfo[]> {
  const xml = await propfind(
    auth,
    home,
    1,
    "<d:displayname/><d:resourcetype/><c:supported-calendar-component-set/><cs:shared-url/>",
  );
  return responses(xml).flatMap((r) => {
    const rt = tag(r, "resourcetype") ?? "";
    const href = tag(r, "href");
    if (!href || !/<(?:[\w-]+:)?calendar\b/i.test(rt)) return [];
    const components = [...(tag(r, "supported-calendar-component-set") ?? "").matchAll(/name="([A-Z]+)"/g)].map(
      (m) => m[1],
    );
    return [
      {
        href: resolveHref(home, href),
        name: xmlText(tag(r, "displayname") ?? ""),
        components,
        shared: /shared/i.test(rt) || tag(r, "shared-url") != null,
      },
    ];
  });
}

// --- events ------------------------------------------------------------------

async function query(auth: CalDavAuth, calendar: string, filter: string, expand = ""): Promise<CalDavEvent[]> {
  const body = `<c:calendar-query ${NS}><d:prop><d:getetag/>${expand ? `<c:calendar-data>${expand}</c:calendar-data>` : "<c:calendar-data/>"}</d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">${filter}</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
  return parseEvents((await dav(auth, "REPORT", calendar, { headers: { Depth: "1", ...XML }, body })).text, calendar);
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]|\.\d{3}/g, "");

/** Every VEVENT resource overlapping [start, end). */
export const listEvents = (auth: CalDavAuth, calendar: string, range: { start: Date; end: Date }) =>
  query(auth, calendar, `<c:time-range start="${stamp(range.start)}" end="${stamp(range.end)}"/>`);

/** Read-only expanded occurrences for duplicate review, never for mirror writes. */
export const listOccurrences = (auth: CalDavAuth, calendar: string, range: { start: Date; end: Date }) =>
  query(
    auth,
    calendar,
    `<c:time-range start="${stamp(range.start)}" end="${stamp(range.end)}"/>`,
    `<c:expand start="${stamp(range.start)}" end="${stamp(range.end)}"/>`,
  );

/** One event by exact UID, regardless of time range. */
export const findByUid = async (auth: CalDavAuth, calendar: string, uid: string) =>
  (
    await query(
      auth,
      calendar,
      `<c:prop-filter name="UID"><c:text-match collation="i;octet">${escapeXml(uid)}</c:text-match></c:prop-filter>`,
    )
  ).find((event) => uidOf(unfold(event.ics)) === uid) ?? null;

export function parseEvents(multistatus: string, base: string): CalDavEvent[] {
  return responses(multistatus).flatMap((r) => {
    const href = tag(r, "href");
    const data = tag(r, "calendar-data");
    if (!href || data == null) return [];
    const etag = tag(r, "getetag");
    return [{ href: resolveHref(base, href), etag: etag ? xmlText(etag).trim() : null, ics: xmlText(data) }];
  });
}

/** PUT an event; `etag: null` means create (If-None-Match: *). */
export async function putEvent(auth: CalDavAuth, href: string, ics: string, etag: string | null): Promise<void> {
  const headers = {
    "Content-Type": "text/calendar; charset=utf-8",
    ...(etag ? { "If-Match": etag } : { "If-None-Match": "*" }),
  };
  await dav(auth, "PUT", href, { body: ics, headers });
}

export async function deleteEvent(auth: CalDavAuth, href: string, etag: string | null): Promise<void> {
  await dav(auth, "DELETE", href, { headers: etag ? { "If-Match": etag } : {} });
}

export const googleCalendarUrl = (calendarId: string) =>
  `https://apidata.googleusercontent.com/caldav/v2/${encodeURIComponent(calendarId)}/events/`;
export const ICLOUD_BASE = "https://caldav.icloud.com/";
