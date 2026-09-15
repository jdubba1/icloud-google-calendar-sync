import { beforeEach, describe, expect, it, vi } from "vitest";

const syncPair = vi.fn();
vi.mock("../src/sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/sync.js")>()),
  syncPair: (...args: unknown[]) => syncPair(...args),
}));

import { createHandler } from "../src/handler.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig(
  {
    google: { clientId: "id", clientSecret: "s", refreshToken: "r" },
    icloud: { username: "u", appPassword: "p" },
    pairs: [{ name: "personal", a: "google:me@gmail.com", b: "icloud:https://x/cal/" }],
  },
  {},
);
const handler = createHandler({ config, secret: "shh" });
const get = (path: string, headers: Record<string, string> = {}) =>
  handler(new Request("http://h" + path, { headers }));

beforeEach(() => syncPair.mockReset());

describe("createHandler", () => {
  it("rejects anonymous callers", async () => {
    expect((await get("/")).status).toBe(401);
    expect(syncPair).not.toHaveBeenCalled();
  });

  it("accepts Bearer or x-api-key and reports per-pair results", async () => {
    syncPair.mockResolvedValue({
      pair: "personal",
      a: 3,
      b: 2,
      created: 1,
      updated: 0,
      deleted: 0,
      skipped: 0,
      errors: [],
    });
    const res = await get("/", { authorization: "Bearer shh" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.results[0].created).toBe(1);
    expect((await get("/", { "x-api-key": "shh" })).status).toBe(200);
  });

  it("dry-run and pair selection pass through; errors become 502", async () => {
    syncPair.mockResolvedValue({
      pair: "personal",
      a: 0,
      b: 0,
      created: 0,
      updated: 0,
      deleted: 0,
      skipped: 0,
      errors: ["boom"],
    });
    const res = await get("/?dry=1&pair=personal", { authorization: "Bearer shh" });
    expect(res.status).toBe(502);
    expect(syncPair.mock.calls[0][2]).toEqual({ dryRun: true });
    expect((await get("/?pair=nope", { authorization: "Bearer shh" })).status).toBe(400);
  });
});
