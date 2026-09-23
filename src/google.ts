import { createHash } from "node:crypto";

// Google OAuth for the calendar mirror. One refresh token, minted once with
// `icloud-google-calendar-sync auth google` (a Desktop OAuth client of your
// own), then held wherever your secrets live. Access tokens are cached
// in-module for their lifetime.

type Cached = { credentials: string; token: string; expiresAt: number };
let cached: Cached | null = null;

export type GoogleOAuthEnv = { clientId: string; clientSecret: string; refreshToken: string };

export function googleEnv(env: NodeJS.ProcessEnv = process.env): GoogleOAuthEnv | null {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;
  return { clientId, clientSecret, refreshToken };
}

export async function googleAccessToken(
  env: GoogleOAuthEnv,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const credentials = createHash("sha256")
    .update(JSON.stringify([env.clientId, env.clientSecret, env.refreshToken]))
    .digest("hex");
  if (cached && cached.credentials === credentials && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.clientId,
      client_secret: env.clientSecret,
      refresh_token: env.refreshToken,
      grant_type: "refresh_token",
    }),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
  });
  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  signal?.throwIfAborted();
  if (!res.ok || typeof json.access_token !== "string" || !json.access_token.trim()) {
    throw new Error(`google token refresh failed (HTTP ${res.status})`);
  }
  const expiresIn = json.expires_in;
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0)
    throw new Error("google token response has invalid expiry");
  cached = { credentials, token: json.access_token, expiresAt: Date.now() + expiresIn * 1000 };
  return cached.token;
}

/** Test seam. */
export function resetGoogleTokenCache(): void {
  cached = null;
}
