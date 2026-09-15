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

describe("custom authorization", () => {
  it("accepts an asynchronous authorization hook without a secret", async () => {
    syncPair.mockResolvedValue({ errors: [] });
    const authorize = vi.fn(async () => true);
    const handler = createHandler({ config, authorize });
    const request = new Request("http://h/");
    expect((await handler(request)).status).toBe(200);
    expect(authorize).toHaveBeenCalledWith(request);
    expect(syncPair).toHaveBeenCalledOnce();
  });

  it("returns a custom denial response without syncing", async () => {
    const denied = new Response("Forbidden", { status: 403 });
    const handler = createHandler({ config, authorize: () => denied });
    expect(await handler(new Request("http://h/"))).toBe(denied);
    expect(syncPair).not.toHaveBeenCalled();
  });

  it("does not let a valid secret bypass a hook denial", async () => {
    const handler = createHandler({ config, secret: "shh", authorize: () => false });
    expect((await handler(new Request("http://h/", { headers: { authorization: "Bearer shh" } }))).status).toBe(401);
    expect(syncPair).not.toHaveBeenCalled();
  });

  it("does not sync if authorization throws", async () => {
    const handler = createHandler({
      config,
      authorize: () => {
        throw new Error("auth unavailable");
      },
    });
    await expect(handler(new Request("http://h/"))).rejects.toThrow("auth unavailable");
    expect(syncPair).not.toHaveBeenCalled();
  });

  it("requires an authentication method", () => {
    expect(() => createHandler({ config })).toThrow(/secret or authorize/);
  });
});
