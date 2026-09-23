import { afterEach, expect, it, vi } from "vitest";
import { dav, scopedAuth, providerUrlPolicy, currentUserPrincipal, type CalDavAuth } from "../src/caldav.js";
import { googleAccessToken } from "../src/google.js";
afterEach(() => vi.unstubAllGlobals());
it.each([
  "https://evil.example/",
  "https://caldav.icloud.com.evil.example/",
  "https://p12-caldav.icloud.com:444/",
  "https://127.0.0.1/",
  "http://caldav.icloud.com/",
])("rejects %s before resolving credentials", async (url) => {
  const token = vi.fn(),
    fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(dav({ kind: "bearer", token, allowUrl: providerUrlPolicy("icloud") }, "GET", url)).rejects.toThrow();
  expect(token).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
it("accepts exact provider destinations and constrains the Google path", () => {
  expect(providerUrlPolicy("icloud")(new URL("https://p123-caldav.icloud.com/123/calendars/"))).toBe(true);
  expect(providerUrlPolicy("google")(new URL("https://apidata.googleusercontent.com/caldav/v2/x/events/"))).toBe(true);
  expect(providerUrlPolicy("google")(new URL("https://apidata.googleusercontent.com/other/"))).toBe(false);
});
it("cannot weaken an auth policy through run options or mutate the sent URL", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const auth: CalDavAuth = { kind: "basic", user: "u", pass: "p", allowUrl: providerUrlPolicy("icloud") };
  await expect(dav(scopedAuth(auth, { allowUrl: () => true }), "GET", "https://evil.example/")).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockResolvedValue(new Response("ok"));
  await dav(
    {
      ...auth,
      allowUrl: (u) => {
        u.hostname = "evil.example";
        return true;
      },
    },
    "GET",
    "https://caldav.icloud.com/",
  );
  expect(fetch.mock.calls[0][0]).toBe("https://caldav.icloud.com/");
});
it("validates provider-discovered URLs before returning them", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          '<d:current-user-principal xmlns:d="DAV:"><d:href>https://other.icloud.com/principal/</d:href></d:current-user-principal>',
        ),
      ),
  );
  await expect(
    currentUserPrincipal(
      { kind: "basic", user: "u", pass: "p", allowUrl: providerUrlPolicy("icloud") },
      "https://caldav.icloud.com/",
    ),
  ).rejects.toThrow(/policy/);
});
it("threads cancellation into token acquisition and the CalDAV request", async () => {
  const controller = new AbortController();
  const token = vi.fn(async (signal?: AbortSignal) => {
    expect(signal).toBe(controller.signal);
    return "token";
  });
  const fetch = vi.fn(async (_url, init) => {
    expect(init.signal.aborted).toBe(false);
    controller.abort();
    expect(init.signal.aborted).toBe(true);
    throw new Error("aborted");
  });
  vi.stubGlobal("fetch", fetch);
  await expect(
    dav({ kind: "bearer", token, signal: controller.signal }, "GET", "https://example.com/"),
  ).rejects.toThrow();
});
it("aborted OAuth refresh performs no network request", async () => {
  const fetch = vi.fn();
  await expect(
    googleAccessToken({ clientId: "i", clientSecret: "s", refreshToken: "r" }, fetch, AbortSignal.abort()),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
