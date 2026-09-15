// A framework-free HTTP handler: (Request) => Response. Drop it into a Next.js
// route, a Cloudflare Worker, Bun.serve, Deno, or anything else that speaks
// the Fetch API. Point a cron at it every few minutes.
//
//   GET /?dry=1        plan only, return the actions, write nothing
//   GET /?pair=<name>  just one pair
//
// Auth: `Authorization: Bearer <secret>` or `x-api-key: <secret>`.

import { pairsFor, type Config } from "./config.js";
import { syncPair, window, type PairResult } from "./sync.js";

export type HandlerOptions = { config: Config; secret: string };

export function createHandler({ config, secret }: HandlerOptions): (req: Request) => Promise<Response> {
  if (!secret) throw new Error("createHandler: a secret is required");
  return async (req) => {
    const auth = req.headers.get("authorization");
    const key = req.headers.get("x-api-key");
    if (auth !== `Bearer ${secret}` && key !== secret) return json({ error: "unauthorized" }, 401);

    const url = new URL(req.url);
    const only = url.searchParams.get("pair");
    const dryRun = url.searchParams.get("dry") === "1";

    let pairs;
    try {
      pairs = pairsFor(config);
    } catch (e) {
      return json({ error: message(e) }, 500);
    }
    const selected = only ? pairs.filter((p) => p.name === only) : pairs;
    if (!selected.length) return json({ error: "no calendar pairs configured" }, 400);

    const win = window(config.window.pastDays, config.window.futureDays);
    const results: PairResult[] = [];
    for (const pair of selected) {
      try {
        results.push(await syncPair(pair, win, { dryRun }));
      } catch (e) {
        results.push({
          pair: pair.name,
          a: 0,
          b: 0,
          created: 0,
          updated: 0,
          deleted: 0,
          skipped: 0,
          errors: [message(e)],
        });
      }
    }
    const failed = results.some((r) => r.errors.length);
    return json(
      { ok: !failed, dryRun, window: { start: win.start.toISOString(), end: win.end.toISOString() }, results },
      failed ? 502 : 200,
    );
  };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
