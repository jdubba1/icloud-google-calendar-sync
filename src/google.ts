// Google OAuth for the calendar mirror. One refresh token, minted once with
// `icloud-google-calendar-sync auth google` (a Desktop OAuth client of your
// own), then held wherever your secrets live. Access tokens are cached
// in-module for their lifetime.

type Cached = { token: string; expiresAt: number };
let cached: Cached | null = null;

export type GoogleOAuthEnv = { clientId: string; clientSecret: string; refreshToken: string };

export function googleEnv(env: NodeJS.ProcessEnv = process.env): GoogleOAuthEnv | null {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;
  return { clientId, clientSecret, refreshToken };
}

export async function googleAccessToken(env: GoogleOAuthEnv, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
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
  });
  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !json.access_token) {
    throw new Error(`google token refresh failed: ${json.error ?? res.status} ${json.error_description ?? ""}`.trim());
  }
  cached = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return cached.token;
}

/** Test seam. */
export function resetGoogleTokenCache(): void {
  cached = null;
}
