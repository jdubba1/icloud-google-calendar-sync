import { describe, expect, it, vi } from "vitest";
import { createJevMatcher, type JevEvent } from "../src/jev.js";

const a: JevEvent = { title: "Hotel booking", start: Date.UTC(2026, 8, 23), end: Date.UTC(2026, 8, 25), allDay: true };
const b: JevEvent = { ...a, title: "Stay at hotel" };
const answer = (p: unknown = 0.99) => ({ answers: { match: { type: "noul", noul: p } } });
function setup(body: unknown = answer()) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json(body));
  return { fetch, matcher: createJevMatcher({ provider: "typesafe", apiKey: "test-key", fetch }) };
}

describe("optional Jev matcher", () => {
  it("only suggests a duplicate, sends an allowlist, and uses the documented API", async () => {
    const { fetch, matcher } = setup();
    const extra = { ...a, description: "private notes", attendees: ["private@example.com"], uid: "secret-uid" };
    expect(await matcher.compare(extra, b)).toMatchObject({ status: "classified", suggestedDuplicate: true });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    const request = JSON.parse(String(init?.body));
    expect(request.model).toBe("jev-latest");
    expect(request.questions.match.type).toBe("noul");
    expect(Object.keys(request.state).sort()).toEqual(["eventA", "eventB"]);
    const events = Object.values(request.state) as Record<string, unknown>[];
    expect(events).toHaveLength(2);
    expect(Object.keys(events[0]).sort()).toEqual(["allDay", "end", "location", "start", "title"]);
    expect(JSON.stringify(request.state)).not.toMatch(/private|secret/);
  });

  it("supports Gateway keys and its native probability-only response", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ answers: { match: { type: "boolean", probability: 0.99 } } }));
    const matcher = createJevMatcher({ provider: "gateway", apiKey: "gateway-key", fetch });
    expect(await matcher.compare(a, b)).toMatchObject({
      status: "classified",
      probability: 0.99,
      suggestedDuplicate: true,
    });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://ai-gateway.vercel.sh/v4/ai/evaluation-model");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer gateway-key",
      "ai-model-id": "typesafe-ai/jev",
      "ai-evaluation-model-specification-version": "4",
      "ai-gateway-auth-method": "api-key",
    });
    const request = JSON.parse(String(init?.body));
    expect(request).not.toHaveProperty("model");
    expect(request.questions.match.type).toBe("boolean");
    expect(request.questions.match).not.toHaveProperty("criteria");
  });

  it("skips nonoverlapping and adjacent occurrences without a request", async () => {
    const { matcher, fetch } = setup();
    expect(await matcher.compare(a, { ...b, start: a.end, end: a.end + 3600000 })).toEqual({
      status: "skipped",
      reason: "no_overlap",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([0, 0.35, 0.5, 0.949, 0.95, 1])("applies the review threshold to %s", async (p) => {
    expect(await setup(answer(p)).matcher.compare(a, b)).toMatchObject({
      status: "classified",
      probability: p,
      suggestedDuplicate: p >= 0.95,
    });
  });

  it.each([0, 0.8, 0.81, 1])("uses a custom threshold of %s", async (threshold) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(answer(0.8)));
    const matcher = createJevMatcher({ provider: "typesafe", apiKey: "test", threshold, fetch });
    expect(await matcher.compare(a, b)).toMatchObject({ probability: 0.8, suggestedDuplicate: 0.8 >= threshold });
  });
  it.each([-0.1, 1.1, NaN, Infinity, "0.9", null])("rejects invalid matcher threshold %s", (threshold) => {
    expect(() => createJevMatcher({ provider: "typesafe", apiKey: "test", threshold: threshold as number })).toThrow(
      /threshold/,
    );
  });
  it("caches reversed pairs, protects cached data, and invalidates on edits", async () => {
    const { matcher, fetch } = setup();
    const result = await matcher.compare(a, b);
    if (result.status === "classified") result.probability = 0;
    expect(await matcher.compare(b, a)).toMatchObject({ probability: 0.99 });
    expect(fetch).toHaveBeenCalledTimes(1);
    await matcher.compare({ ...a, location: "different hotel" }, b);
    expect(fetch).toHaveBeenCalledTimes(2);
    matcher.clearCache();
    await matcher.compare(a, b);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("bounds the cache and supports disabling it", async () => {
    for (const cacheSize of [0, 1]) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json(answer()));
      const matcher = createJevMatcher({ provider: "typesafe", apiKey: "test", fetch, cacheSize });
      await matcher.compare(a, b);
      await matcher.compare({ ...a, title: "Other" }, b);
      await matcher.compare(a, b);
      expect(fetch).toHaveBeenCalledTimes(3);
    }
  });

  it("reuses stored probabilities across matchers and applies the current threshold", async () => {
    const saved = new Map<string, number>();
    const store = { get: (k: string) => saved.get(k), set: (k: string, p: number) => void saved.set(k, p) };
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json(answer(0.9)));
    const first = createJevMatcher({ provider: "typesafe", apiKey: "test", fetch, store });
    expect(await first.compare(a, b)).toMatchObject({ probability: 0.9, suggestedDuplicate: false });
    expect([...saved.values()]).toEqual([0.9]);
    const second = createJevMatcher({ provider: "typesafe", apiKey: "test", fetch, store, threshold: 0.8 });
    expect(await second.compare(b, a)).toEqual({ status: "classified", probability: 0.9, suggestedDuplicate: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    const gateway = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ answers: { match: { type: "boolean", probability: 0.5 } } }));
    await createJevMatcher({ provider: "gateway", apiKey: "test", fetch: gateway, store }).compare(a, b);
    expect(gateway).toHaveBeenCalledTimes(1);
    expect(saved.size).toBe(2);
  });

  it("treats store failures and invalid stored values as cache misses", async () => {
    for (const store of [
      { get: () => Promise.reject(new Error("db down")), set: () => Promise.reject(new Error("db down")) },
      { get: () => 7, set: () => {} },
    ]) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json(answer()));
      const matcher = createJevMatcher({ provider: "typesafe", apiKey: "test", fetch, store });
      expect(await matcher.compare(a, b)).toMatchObject({ status: "classified", probability: 0.99 });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("does not store unavailable results", async () => {
    const set = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("busy", { status: 503 }));
    const matcher = createJevMatcher({
      provider: "typesafe",
      apiKey: "test",
      fetch,
      store: { get: () => undefined, set },
    });
    expect(await matcher.compare(a, b)).toEqual({ status: "unavailable" });
    expect(set).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { answers: null },
    answer(-0.1),
    answer(1.1),
    answer("0.99"),
    answer(null),
    answer(NaN),
    { answers: { match: { type: "choice", noul: 0.99 } } },
    { answers: { match: { type: "boolean", probability: 0.99 } } },
  ])("rejects malformed or wrong-provider output %#", async (body) => {
    expect(await setup(body).matcher.compare(a, b)).toEqual({ status: "unavailable" });
  });

  it("does not retry or cache failures, and never exposes provider error text", async () => {
    const { matcher, fetch } = setup();
    fetch.mockRejectedValueOnce(new Error("test-key private notes"));
    expect(await matcher.compare(a, b)).toEqual({ status: "unavailable" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await matcher.compare(a, b)).toMatchObject({ status: "classified" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("handles HTTP errors and invalid JSON", async () => {
    const { matcher, fetch } = setup();
    for (const response of [new Response("secret", { status: 429 }), new Response("not json")]) {
      fetch.mockResolvedValueOnce(response);
      expect(await matcher.compare(a, b)).toEqual({ status: "unavailable" });
    }
  });

  it("aborts slow requests", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) =>
            init?.signal?.addEventListener("abort", () => reject(new Error("timeout")), { once: true }),
          ),
      );
    const matcher = createJevMatcher({ provider: "typesafe", apiKey: "test", fetch, timeoutMs: 5 });
    expect(await matcher.compare(a, b)).toEqual({ status: "unavailable" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("validates configuration and occurrences before sending anything", async () => {
    expect(() => createJevMatcher({ provider: "typesafe", apiKey: "" })).toThrow();
    expect(() => createJevMatcher({ provider: "typesafe", apiKey: "test", timeoutMs: -1 })).toThrow();
    expect(() => createJevMatcher({ provider: "typesafe", apiKey: "test", cacheSize: Infinity })).toThrow();
    const { matcher, fetch } = setup();
    for (const event of [
      { ...a, title: " " },
      { ...a, title: "x".repeat(501) },
      { ...a, start: NaN },
      { ...a, end: a.start },
      { ...a, end: 9e15 },
    ]) {
      await expect(matcher.compare(event, b)).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

it("supports explicit Gateway OIDC without treating tokens as static API keys", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(Response.json({ answers: { match: { type: "boolean", probability: 0.99 } } }));
  const matcher = createJevMatcher({ provider: "gateway", apiKey: "oidc-token", gatewayAuth: "oidc", fetch });
  expect(await matcher.compare(a, b)).toMatchObject({ status: "classified", probability: 0.99 });
  expect(fetch.mock.calls[0][1]?.headers).toMatchObject({
    Authorization: "Bearer oidc-token",
    "ai-gateway-auth-method": "oidc",
  });
  expect(() => createJevMatcher({ provider: "typesafe", apiKey: "key", gatewayAuth: "oidc" })).toThrow();
});

it.each([
  { type: "boolean", probability: "0.99" },
  { type: "boolean", probability: 1.1 },
  { type: "noul", noul: 0.99 },
])("rejects invalid Gateway answers %#", async (match) => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ answers: { match } }));
  const matcher = createJevMatcher({ provider: "gateway", apiKey: "test", fetch });
  expect(await matcher.compare(a, b)).toEqual({ status: "unavailable" });
});
