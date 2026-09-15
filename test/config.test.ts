import { describe, expect, it } from "vitest";
import { loadConfig, pairsFor, resolveValue } from "../src/config.js";

const env = {
  GOOGLE_OAUTH_CLIENT_SECRET: "sec",
  GOOGLE_OAUTH_REFRESH_TOKEN: "rt",
  ICLOUD_APP_PASSWORD: "app-pw",
};

describe("loadConfig", () => {
  it("reads a file with env: indirection for secrets", () => {
    const cfg = loadConfig(
      {
        google: {
          clientId: "id",
          clientSecret: "env:GOOGLE_OAUTH_CLIENT_SECRET",
          refreshToken: "env:GOOGLE_OAUTH_REFRESH_TOKEN",
        },
        icloud: { username: "me@icloud.com", appPassword: "env:ICLOUD_APP_PASSWORD" },
        pairs: [{ name: "p", a: "google:me@gmail.com", b: "icloud:https://p1-caldav.icloud.com/1/calendars/home" }],
        window: { pastDays: 7 },
      },
      env,
    );
    expect(cfg.google).toEqual({ clientId: "id", clientSecret: "sec", refreshToken: "rt" });
    expect(cfg.icloud).toEqual({ username: "me@icloud.com", appPassword: "app-pw" });
    expect(cfg.window).toEqual({ pastDays: 7, futureDays: 365 });
    const [pair] = pairsFor(cfg);
    expect(pair.a.url).toBe("https://apidata.googleusercontent.com/caldav/v2/me%40gmail.com/events/");
    expect(pair.b.url).toBe("https://p1-caldav.icloud.com/1/calendars/home/");
  });

  it("falls back to plain env when there is no file", () => {
    const cfg = loadConfig(null, {
      ...env,
      GOOGLE_OAUTH_CLIENT_ID: "id",
      ICLOUD_USERNAME: "me@icloud.com",
      CALENDAR_PAIRS: JSON.stringify([{ name: "p", a: "google:primary", b: "icloud:https://x/" }]),
      CALENDAR_SYNC_FUTURE_DAYS: "90",
    });
    expect(cfg.google?.clientId).toBe("id");
    expect(cfg.pairs).toHaveLength(1);
    expect(cfg.window.futureDays).toBe(90);
  });

  it("a missing env: value leaves the credential null instead of a literal string", () => {
    const cfg = loadConfig({ icloud: { username: "u", appPassword: "env:NOPE" } }, {});
    expect(cfg.icloud).toBeNull();
    expect(resolveValue("plain", {})).toBe("plain");
  });

  it("rejects a side it does not understand", () => {
    const cfg = loadConfig({ pairs: [{ name: "p", a: "outlook:x", b: "icloud:https://x/" }] }, env);
    expect(() => pairsFor(cfg)).toThrow(/unknown calendar side/);
  });
});
