#!/usr/bin/env node
// icloud-google-calendar-sync: the command line.
//
//   auth google        mint a Google refresh token with your own Desktop OAuth client
//   discover icloud    list iCloud calendar collection URLs (for the config file)
//   discover google    list Google calendar ids
//   sync [--dry] [--pair NAME]   run the mirror once
//
// Config: --config <path> (default ./mirror.config.json if present), plus env.

import { createServer } from "node:http";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { calendarHome, currentUserPrincipal, ICLOUD_BASE, listCalendars, type CalDavAuth } from "./caldav.js";
import { authsFor, loadConfig, pairsFor, type Config } from "./config.js";
import { googleAccessToken } from "./google.js";
import { syncPair, window } from "./sync.js";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(name);

function readConfig(): Config {
  const path = flag("--config") ?? (existsSync("mirror.config.json") ? "mirror.config.json" : null);
  const file = path ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : null;
  return loadConfig(file);
}

async function discoverIcloud(config: Config): Promise<void> {
  const { icloud } = authsFor(config);
  if (!icloud) throw new Error("icloud username / appPassword missing");
  const principal = await currentUserPrincipal(icloud, ICLOUD_BASE);
  const home = await calendarHome(icloud, principal);
  const cals = await listCalendars(icloud, home);
  console.log(`# ${cals.length} collection(s) under ${home}`);
  for (const c of cals) {
    const tag = c.shared ? " (shared)" : "";
    console.log(`${JSON.stringify(c.name)}${tag}\n  icloud:${c.href}`);
  }
}

async function discoverGoogle(config: Config): Promise<void> {
  if (!config.google) throw new Error("google credentials missing");
  const token = await googleAccessToken(config.google);
  const res = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as {
    items?: { id: string; summary: string; accessRole: string; primary?: boolean }[];
    error?: unknown;
  };
  if (!res.ok || !body.items) throw new Error(`calendarList failed: ${JSON.stringify(body.error ?? body)}`);
  for (const c of body.items) {
    console.log(`${JSON.stringify(c.summary)} (${c.accessRole}${c.primary ? ", primary" : ""})\n  google:${c.id}`);
  }
}

/** Loopback OAuth flow for a Desktop-type client. Prints a refresh token. */
async function authGoogle(): Promise<void> {
  const clientId = flag("--client-id") ?? process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = flag("--client-secret") ?? process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "need --client-id and --client-secret (a Desktop OAuth client from console.cloud.google.com, with the Calendar API and CalDAV API enabled)",
    );
  }
  const port = Number(flag("--port") ?? 8765);
  const redirect = `http://localhost:${port}/`;
  const url =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirect,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/calendar",
      access_type: "offline",
      prompt: "consent",
    });
  console.log("Open this in a browser and approve:\n\n  " + url + "\n");
  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const q = new URL(req.url ?? "/", redirect).searchParams;
      res.end("<h2>Done. You can close this tab.</h2>");
      server.close();
      const c = q.get("code");
      c ? resolve(c) : reject(new Error(q.get("error") ?? "no code"));
    });
    server.listen(port);
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirect,
      grant_type: "authorization_code",
    }),
  });
  const tok = (await res.json()) as { refresh_token?: string; error?: string; error_description?: string };
  if (!tok.refresh_token) throw new Error(`token exchange failed: ${tok.error} ${tok.error_description ?? ""}`);
  const out = flag("--out");
  if (out) {
    writeFileSync(out, JSON.stringify({ clientId, clientSecret, refreshToken: tok.refresh_token }, null, 2) + "\n", {
      mode: 0o600,
    });
    console.log(`saved ${out}`);
  } else {
    console.log("GOOGLE_OAUTH_REFRESH_TOKEN=" + tok.refresh_token);
  }
}

async function sync(config: Config): Promise<void> {
  const dryRun = has("--dry");
  const only = flag("--pair");
  const pairs = pairsFor(config).filter((p) => !only || p.name === only);
  if (!pairs.length) throw new Error("no pairs configured" + (only ? ` named ${only}` : ""));
  const win = window(config.window.pastDays, config.window.futureDays);
  let failed = false;
  for (const pair of pairs) {
    const r = await syncPair(pair, win, { dryRun });
    failed ||= r.errors.length > 0;
    console.log(
      `${r.pair}: a=${r.a} b=${r.b} created=${r.created} updated=${r.updated} deleted=${r.deleted} skipped=${r.skipped}${dryRun ? " (dry)" : ""}`,
    );
    for (const a of r.actions ?? []) console.log(`  ${a.kind} → ${a.on}: ${a.why}`);
    for (const e of r.errors) console.log(`  ERROR ${e}`);
  }
  if (failed) process.exitCode = 1;
}

async function main(): Promise<void> {
  const [cmd, sub] = args;
  if (cmd === "auth" && sub === "google") return authGoogle();
  if (cmd === "discover" && sub === "icloud") return discoverIcloud(readConfig());
  if (cmd === "discover" && sub === "google") return discoverGoogle(readConfig());
  if (cmd === "sync") return sync(readConfig());
  console.log(
    "usage: icloud-google-calendar-sync <auth google | discover icloud | discover google | sync [--dry] [--pair NAME]> [--config path]",
  );
  process.exitCode = 2;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
