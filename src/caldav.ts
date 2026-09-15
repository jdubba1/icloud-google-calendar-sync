// A CalDAV client small enough to read in one sitting. Both sides of the
// mirror speak it: iCloud with an app-specific password (Basic), Google via
// its CalDAV v2 endpoint (Bearer, OAuth refresh token). Everything is a
// handful of HTTP verbs with XML bodies; responses are picked apart with
// regexes because the shapes are fixed and a DOM parser is not available in
// the route runtime.

export type CalDavAuth =
  { kind: "basic"; user: string; pass: string } | { kind: "bearer"; token: () => Promise<string> };

export type CalDavEvent = { href: string; etag: string | null; ics: string };

const NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/"';

async function authHeader(auth: CalDavAuth): Promise<string> {
  if (auth.kind === "basic") {
    return "Basic " + Buffer.from(`${auth.user}:${auth.pass}`).toString("base64");
  }
  return "Bearer " + (await auth.token());
}

export class CalDavError extends Error {
  readonly status: number;
  readonly method: string;
  readonly url: string;
  constructor(status: number, method: string, url: string, body: string) {
    super(`${method} ${url} → ${status}: ${body.slice(0, 300)}`);
    this.status = status;
    this.method = method;
    this.url = url;
  }
}

export async function dav(
  auth: CalDavAuth,
  method: string,
  url: string,
  init: { body?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; text: string; headers: Headers }> {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: await authHeader(auth),
      "User-Agent": "icloud-google-calendar-sync/0.1",
      ...init.headers,
    },
    body: init.body,
    // Never let Next cache a DAV call.
    cache: "no-store",
  });
  const text = await res.text();
  if (res.status >= 400) throw new CalDavError(res.status, method, url, text);
  return { status: res.status, text, headers: res.headers };
}

/** Unescape XML text content (calendar-data comes back entity-escaped or in CDATA). */
export function xmlText(s: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s);
  const raw = cdata ? cdata[1] : s;
  return raw
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

/** `<x:tag ...>inner</x:tag>` → inner, first match, any prefix. */
function tag(xml: string, local: string): string | null {
  const re = new RegExp(`<(?:[\\w-]+:)?${local}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${local}>`, "i");
  const m = re.exec(xml);
  return m ? m[1] : null;
}

/** Split a multistatus body into per-resource <response> chunks. */
export function responses(xml: string): string[] {
  return [...xml.matchAll(/<(?:[\w-]+:)?response(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi)].map((m) => m[1]);
}

function resolveHref(base: string, href: string): string {
  return new URL(xmlText(href.trim()), base).toString();
}

// --- discovery (used once, from the CLI helper, to find calendar URLs) -------

export async function currentUserPrincipal(auth: CalDavAuth, base: string): Promise<string> {
  const { text } = await dav(auth, "PROPFIND", base, {
    headers: { Depth: "0", "Content-Type": "application/xml" },
    body: `<d:propfind ${NS}><d:prop><d:current-user-principal/></d:prop></d:propfind>`,
  });
  const href = tag(tag(text, "current-user-principal") ?? "", "href");
  if (!href) throw new Error("no current-user-principal in " + text.slice(0, 200));
  return resolveHref(base, href);
}

export async function calendarHome(auth: CalDavAuth, principal: string): Promise<string> {
  const { text } = await dav(auth, "PROPFIND", principal, {
    headers: { Depth: "0", "Content-Type": "application/xml" },
    body: `<d:propfind ${NS}><d:prop><c:calendar-home-set/></d:prop></d:propfind>`,
  });
  const href = tag(tag(text, "calendar-home-set") ?? "", "href");
  if (!href) throw new Error("no calendar-home-set in " + text.slice(0, 200));
  return resolveHref(principal, href);
}

export type CalendarInfo = { href: string; name: string; components: string[]; shared: boolean };

export async function listCalendars(auth: CalDavAuth, home: string): Promise<CalendarInfo[]> {
  const { text } = await dav(auth, "PROPFIND", home, {
    headers: { Depth: "1", "Content-Type": "application/xml" },
    body: `<d:propfind ${NS}><d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/><cs:shared-url/></d:prop></d:propfind>`,
  });
  const out: CalendarInfo[] = [];
  for (const r of responses(text)) {
    const rt = tag(r, "resourcetype") ?? "";
    if (!/<(?:[\w-]+:)?calendar\b/i.test(rt)) continue;
    const href = tag(r, "href");
    if (!href) continue;
    const comps = [...(tag(r, "supported-calendar-component-set") ?? "").matchAll(/name="([A-Z]+)"/g)].map((m) => m[1]);
    out.push({
      href: resolveHref(home, href),
      name: xmlText(tag(r, "displayname") ?? ""),
      components: comps,
      shared: /shared/i.test(rt) || tag(r, "shared-url") != null,
    });
  }
  return out;
}

// --- events ------------------------------------------------------------------

const stamp = (d: Date) => d.toISOString().replace(/[-:]|\.\d{3}/g, "");

/** Every VEVENT resource overlapping [start, end), full calendar-data included. */
export async function listEvents(
  auth: CalDavAuth,
  calendar: string,
  range: { start: Date; end: Date },
): Promise<CalDavEvent[]> {
  const { text } = await dav(auth, "REPORT", calendar, {
    headers: { Depth: "1", "Content-Type": "application/xml" },
    body: `<c:calendar-query ${NS}><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${stamp(range.start)}" end="${stamp(range.end)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`,
  });
  return parseEvents(text, calendar);
}

/** Look one event up by UID, regardless of time range. */
export async function findByUid(auth: CalDavAuth, calendar: string, uid: string): Promise<CalDavEvent | null> {
  const { text } = await dav(auth, "REPORT", calendar, {
    headers: { Depth: "1", "Content-Type": "application/xml" },
    body: `<c:calendar-query ${NS}><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:prop-filter name="UID"><c:text-match collation="i;octet">${escapeXml(uid)}</c:text-match></c:prop-filter></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`,
  });
  return parseEvents(text, calendar)[0] ?? null;
}

export function parseEvents(multistatus: string, base: string): CalDavEvent[] {
  const out: CalDavEvent[] = [];
  for (const r of responses(multistatus)) {
    const href = tag(r, "href");
    const data = tag(r, "calendar-data");
    if (!href || data == null) continue;
    const etag = tag(r, "getetag");
    out.push({
      href: resolveHref(base, href),
      etag: etag ? xmlText(etag).trim() : null,
      ics: xmlText(data),
    });
  }
  return out;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function putEvent(
  auth: CalDavAuth,
  href: string,
  ics: string,
  guard: { create: true } | { etag: string | null },
): Promise<string | null> {
  const headers: Record<string, string> = { "Content-Type": "text/calendar; charset=utf-8" };
  if ("create" in guard) headers["If-None-Match"] = "*";
  else if (guard.etag) headers["If-Match"] = guard.etag;
  const { headers: h } = await dav(auth, "PUT", href, { body: ics, headers });
  return h.get("etag");
}

export async function deleteEvent(auth: CalDavAuth, href: string, etag: string | null): Promise<void> {
  await dav(auth, "DELETE", href, { headers: etag ? { "If-Match": etag } : {} });
}

/** Google's CalDAV v2 collection URL for a calendar id. */
export const googleCalendarUrl = (calendarId: string): string =>
  `https://apidata.googleusercontent.com/caldav/v2/${encodeURIComponent(calendarId)}/events/`;

export const ICLOUD_BASE = "https://caldav.icloud.com/";
