import { describe, expect, it, vi } from "vitest";
import { createJevMatcher, type JevEvent } from "../src/jev.js";

const a: JevEvent = { title: "Hotel booking", start: Date.UTC(2026, 8, 23), end: Date.UTC(2026, 8, 25), allDay: true };
const b: JevEvent = { ...a, title: "Stay at hotel" };
const answer = (choice = "same_event", same = 0.99, confidence = 0.98) => ({
  answers: {
    match: {
      type: "choice",
      choice,
      confidence,
      probabilities: { same_event: same, related: 1 - same, different: 0, uncertain: 0 },
    },
  },
});
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
    expect(request.questions.match.type).toBe("choice");
    const events = JSON.parse(request.state);
    expect(events).toHaveLength(2);
    expect(Object.keys(events[0]).sort()).toEqual(["allDay", "end", "location", "start", "title"]);
    expect(request.state).not.toMatch(/private|secret/);
  });

  it("supports Gateway keys and its native probability-only response", async () => {
    const body = answer();
    const { confidence: _confidence, ...match } = body.answers.match;
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ answers: { match } }));
    const matcher = createJevMatcher({ provider: "gateway", apiKey: "gateway-key", fetch });
    expect(await matcher.compare(a, b)).toMatchObject({
      status: "classified",
      confidence: null,
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
    expect(request.questions.match.criteria).toHaveProperty("uncertain");
  });

  it("uses declared probability rounding and rejects invalid rounding", async () => {
    const response = { ...answer(), rounding: { probabilityDecimals: 2 } };
    response.answers.match.probabilities.related = 0.02;
    expect(await setup(response).matcher.compare(a, b)).toMatchObject({ status: "classified" });
    response.rounding.probabilityDecimals = -1;
    expect(await setup(response).matcher.compare(a, b)).toEqual({ status: "unavailable" });
  });

  it("skips nonoverlapping and adjacent occurrences without a request", async () => {
    const { matcher, fetch } = setup();
    expect(await matcher.compare(a, { ...b, start: a.end, end: a.end + 3600000 })).toEqual({
      status: "skipped",
      reason: "no_overlap",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["related", 0.01, 0.98],
    ["same_event", 0.6, 0.98],
  ])("does not suggest duplicates for %s with probability %s and confidence %s", async (choice, p, confidence) => {
    const { matcher } = setup(answer(choice, p, confidence));
    expect(await matcher.compare(a, b)).toMatchObject({ status: "classified", suggestedDuplicate: false });
  });

  it("caches reversed pairs, protects cached data, and invalidates on edits", async () => {
    const { matcher, fetch } = setup();
    const result = await matcher.compare(a, b);
    if (result.status === "classified") result.probabilities.same_event = 0;
    expect(await matcher.compare(b, a)).toMatchObject({ probabilities: { same_event: 0.99 } });
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

  it.each([
    {},
    { answers: null },
    answer("delete_everything"),
    answer("same_event", 1.1),
    { answers: { match: { ...answer().answers.match, probabilities: { same_event: 1 } } } },
    {
      answers: {
        match: {
          ...answer().answers.match,
          probabilities: { same_event: 0.99, related: 0.9, different: 0, uncertain: 0 },
        },
      },
    },
    answer("related", 0.99),
    answer("same_event", 0.99, NaN),
  ])("rejects malformed or inconsistent provider output %#", async (body) => {
    const { matcher } = setup(body);
    expect(await matcher.compare(a, b)).toEqual({ status: "unavailable" });
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
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(answer()));
  const matcher = createJevMatcher({ provider: "gateway", apiKey: "oidc-token", gatewayAuth: "oidc", fetch });
  await matcher.compare(a, b);
  expect(fetch.mock.calls[0][1]?.headers).toMatchObject({
    Authorization: "Bearer oidc-token",
    "ai-gateway-auth-method": "oidc",
  });
  expect(() => createJevMatcher({ provider: "typesafe", apiKey: "key", gatewayAuth: "oidc" })).toThrow();
});
