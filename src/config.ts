// Configuration. Two sources, merged: a JSON file (pairs, window, auth) and
// environment variables. Any string value in the file may be "env:NAME" to
// pull a secret from the environment, so the file itself can be committed.
//
// {
//   "google": { "clientId": "…", "clientSecret": "env:GOOGLE_CLIENT_SECRET", "refreshToken": "env:GOOGLE_REFRESH_TOKEN" },
//   "icloud": { "username": "you@icloud.com", "appPassword": "env:ICLOUD_APP_PASSWORD" },
//   "pairs": [
//     { "name": "personal", "a": "google:primary", "b": "icloud:https://pNN-caldav.icloud.com/<id>/calendars/home/" }
//   ],
//   "window": { "pastDays": 30, "futureDays": 365 }
// }
//
// Without a file, the same settings come from env: GOOGLE_OAUTH_CLIENT_ID,
// GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN, ICLOUD_USERNAME,
// ICLOUD_APP_PASSWORD, CALENDAR_PAIRS (JSON array), CALENDAR_SYNC_PAST_DAYS,
// CALENDAR_SYNC_FUTURE_DAYS.

import type { CalDavAuth } from "./caldav.js";
import { googleCalendarUrl } from "./caldav.js";
import { googleAccessToken, type GoogleOAuthEnv } from "./google.js";
import type { Pair, Side } from "./sync.js";

export type PairSpec = { name: string; a: string; b: string };
export type WindowDays = { pastDays: number; futureDays: number };

export type Config = {
  google: GoogleOAuthEnv | null;
  icloud: { username: string; appPassword: string } | null;
  pairs: PairSpec[];
  window: WindowDays;
};

type Env = Record<string, string | undefined>;

/** "env:NAME" → process.env.NAME; anything else passes through. */
export function resolveValue(v: unknown, env: Env): string | undefined {
  if (typeof v !== "string") return undefined;
  if (v.startsWith("env:")) return env[v.slice(4)];
  return v;
}

export function parsePairSpecs(raw: unknown): PairSpec[] {
  if (raw == null) return [];
  const v: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!Array.isArray(v)) throw new Error("pairs must be an array");
  return v.map((p, i) => {
    if (!p || typeof p !== "object") throw new Error(`pairs[${i}] must be an object`);
    const { name, a, b } = p as Record<string, unknown>;
    if (typeof name !== "string" || typeof a !== "string" || typeof b !== "string") {
      throw new Error(`pairs[${i}] needs string name, a, b`);
    }
    return { name, a, b };
  });
}

function num(v: unknown, fallback: number, min: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/** Build a Config from an optional parsed JSON file plus the environment. */
export function loadConfig(file: Record<string, unknown> | null, env: Env = process.env): Config {
  const g = (file?.google ?? {}) as Record<string, unknown>;
  const clientId = resolveValue(g.clientId, env) ?? env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = resolveValue(g.clientSecret, env) ?? env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = resolveValue(g.refreshToken, env) ?? env.GOOGLE_OAUTH_REFRESH_TOKEN;
  const google = clientId && clientSecret && refreshToken ? { clientId, clientSecret, refreshToken } : null;

  const i = (file?.icloud ?? {}) as Record<string, unknown>;
  const username = resolveValue(i.username, env) ?? env.ICLOUD_USERNAME;
  const appPassword = resolveValue(i.appPassword, env) ?? env.ICLOUD_APP_PASSWORD;
  const icloud = username && appPassword ? { username, appPassword } : null;

  const pairs = parsePairSpecs(file?.pairs ?? env.CALENDAR_PAIRS);
  const w = (file?.window ?? {}) as Record<string, unknown>;
  const window = {
    pastDays: num(w.pastDays ?? env.CALENDAR_SYNC_PAST_DAYS, 30, 0),
    futureDays: num(w.futureDays ?? env.CALENDAR_SYNC_FUTURE_DAYS, 365, 1),
  };
  return { google, icloud, pairs, window };
}

export function authsFor(config: Config): { google: CalDavAuth | null; icloud: CalDavAuth | null } {
  const g = config.google;
  return {
    google: g ? { kind: "bearer", token: () => googleAccessToken(g) } : null,
    icloud: config.icloud ? { kind: "basic", user: config.icloud.username, pass: config.icloud.appPassword } : null,
  };
}

export function resolveSide(spec: string, auths: ReturnType<typeof authsFor>): Side {
  const i = spec.indexOf(":");
  const kind = spec.slice(0, i);
  const rest = spec.slice(i + 1);
  if (kind === "google") {
    if (!auths.google) throw new Error("google credentials missing (clientId / clientSecret / refreshToken)");
    return { id: "google", auth: auths.google, url: googleCalendarUrl(rest) };
  }
  if (kind === "icloud") {
    if (!auths.icloud) throw new Error("icloud credentials missing (username / appPassword)");
    return { id: "icloud", auth: auths.icloud, url: rest.endsWith("/") ? rest : rest + "/" };
  }
  throw new Error(`unknown calendar side "${kind}" in "${spec}" (use google:<calendarId> or icloud:<collection url>)`);
}

export function pairsFor(config: Config): Pair[] {
  const auths = authsFor(config);
  return config.pairs.map((p) => ({ name: p.name, a: resolveSide(p.a, auths), b: resolveSide(p.b, auths) }));
}
