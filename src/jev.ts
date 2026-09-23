import { createHash } from "node:crypto";

/** One expanded occurrence. Resolve time zones before passing epoch milliseconds. */
export interface JevEvent {
  title: string;
  start: number;
  end: number;
  allDay?: boolean;
  location?: string;
}

export type JevComparison =
  | { status: "skipped"; reason: "no_overlap" }
  | { status: "unavailable" }
  | {
      status: "classified";
      probability: number;
      /** A suggestion for human review, never permission to modify a calendar. */
      suggestedDuplicate: boolean;
    };

/**
 * Optional cache that outlives one matcher, e.g. a database table shared by cron runs.
 * Keys are SHA-256 hashes of the provider and compared fields; values are probabilities.
 * Store failures are treated as cache misses.
 */
export interface JevStore {
  get(key: string): Promise<number | undefined> | number | undefined;
  set(key: string, probability: number): Promise<void> | void;
}

export interface JevOptions {
  provider: "gateway" | "typesafe";
  /** The API key for the selected provider. Keys are never auto-detected. */
  apiKey: string;
  /** Gateway only: set oidc when apiKey contains a request-scoped Vercel OIDC token. */
  gatewayAuth?: "api-key" | "oidc";
  /** Minimum duplicate probability for review, from 0 to 1. Defaults to 0.95. */
  threshold?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Successful results retained per matcher instance; zero disables caching. */
  cacheSize?: number;
  store?: JevStore;
  fetch?: typeof globalThis.fetch;
}

// Provider-specific transport stays separate from event comparison and validation.
const providers = {
  gateway: {
    url: "https://ai-gateway.vercel.sh/v4/ai/evaluation-model",
    headers: {
      "ai-gateway-protocol-version": "0.0.1",
      "ai-gateway-auth-method": "api-key",
      "ai-evaluation-model-specification-version": "4",
      "ai-model-id": "typesafe-ai/jev",
    },
    body: {},
  },
  typesafe: {
    url: "https://api.typesafe.ai/v1/systemone",
    headers: {},
    body: { model: "jev-latest" },
  },
} satisfies Record<string, { url: string; headers: Record<string, string>; body: object }>;

const probability = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function eventData(event: JevEvent) {
  if (
    typeof event.title !== "string" ||
    !event.title.trim() ||
    event.title.length > 500 ||
    !Number.isFinite(event.start) ||
    !Number.isFinite(event.end) ||
    Math.abs(event.start) > 8.64e15 ||
    Math.abs(event.end) > 8.64e15 ||
    event.end <= event.start ||
    (event.allDay !== undefined && typeof event.allDay !== "boolean") ||
    (event.location !== undefined && (typeof event.location !== "string" || event.location.length > 500))
  )
    throw new Error(
      "Provide a title, valid occurrence interval, and optional location (text fields <= 500 characters)",
    );
  // Explicit allowlist: never forward IDs, attendees, descriptions or extra properties.
  return {
    title: event.title.trim(),
    start: new Date(event.start).toISOString(),
    end: new Date(event.end).toISOString(),
    allDay: event.allDay ?? false,
    location: event.location?.trim() ?? "",
  };
}

/** Optional, read-only matching through Jev. No automatic retries. */
export function createJevMatcher(options: JevOptions) {
  const { apiKey, threshold = 0.95, timeoutMs = 5000, cacheSize = 500, fetch: request = globalThis.fetch } = options;
  if (!Object.hasOwn(providers, options.provider)) throw new Error("Choose gateway or typesafe");
  const provider = providers[options.provider];
  if (
    options.gatewayAuth !== undefined &&
    (options.provider !== "gateway" || !["api-key", "oidc"].includes(options.gatewayAuth))
  )
    throw new Error("gatewayAuth is only supported for Gateway and must be api-key or oidc");
  if (!apiKey?.trim()) throw new Error("Provide an API key for the selected provider");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw new Error("timeoutMs must be an integer between 1 and 60000");
  if (!Number.isInteger(cacheSize) || cacheSize < 0 || cacheSize > 10000)
    throw new Error("cacheSize must be an integer between 0 and 10000");
  if (!probability(threshold)) throw new Error("threshold must be a finite number from 0 to 1");
  const cache = new Map<string, JevComparison>();
  const { store } = options;
  const classified = (p: number): JevComparison => ({
    status: "classified",
    probability: p,
    suggestedDuplicate: p >= threshold,
  });
  const remember = (key: string, result: JevComparison) => {
    if (cacheSize === 0) return;
    if (cache.size >= cacheSize) cache.delete(cache.keys().next().value!);
    cache.set(key, structuredClone(result));
  };

  return {
    async compare(a: JevEvent, b: JevEvent): Promise<JevComparison> {
      options.signal?.throwIfAborted();
      const events = [eventData(a), eventData(b)];
      // Half-open intervals: adjacent reservations are not duplicate candidates.
      if (a.start >= b.end || b.start >= a.end) return { status: "skipped", reason: "no_overlap" };
      const [eventA, eventB] = events.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      const state = { eventA, eventB };
      const key = createHash("sha256")
        .update(JSON.stringify({ provider: options.provider, state }))
        .digest("hex");
      const cached = cache.get(key);
      if (cached) return structuredClone(cached);
      if (store) {
        let stored: unknown;
        try {
          stored = await store.get(key);
        } catch {
          // A broken cache costs a provider call, not a failed review.
        }
        options.signal?.throwIfAborted();
        if (probability(stored)) {
          const result = classified(stored);
          remember(key, result);
          return result;
        }
      }
      try {
        const response = await request(provider.url, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : [])]),
          headers: {
            ...provider.headers,
            ...(options.provider === "gateway" ? { "ai-gateway-auth-method": options.gatewayAuth ?? "api-key" } : {}),
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ...provider.body,
            state,
            questions: {
              match: {
                type: options.provider === "gateway" ? "boolean" : "noul",
                instructions: "Do eventA and eventB describe the same real-world event or reservation?",
              },
            },
          }),
        });
        if (!response.ok) return { status: "unavailable" };
        const body = object(await response.json());
        options.signal?.throwIfAborted();
        const answer = object(object(body.answers).match);
        const expectedType = options.provider === "gateway" ? "boolean" : "noul";
        const p = options.provider === "gateway" ? answer.probability : answer.noul;
        if (answer.type !== expectedType || !probability(p)) return { status: "unavailable" };
        const result = classified(p);
        remember(key, result);
        if (store) {
          try {
            await store.set(key, p);
          } catch {
            // The result is still valid; the next run pays for it again.
          }
        }
        return result;
      } catch {
        options.signal?.throwIfAborted();
        // Provider exceptions can contain credentials or event text. Do not expose them.
        return { status: "unavailable" };
      }
    },
    clearCache() {
      cache.clear();
    },
  };
}
