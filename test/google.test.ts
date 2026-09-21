import { beforeEach, expect, it, vi } from "vitest";
import { googleAccessToken, resetGoogleTokenCache } from "../src/google.js";
const account = { clientId: "client", clientSecret: "secret", refreshToken: "account-a" };
beforeEach(resetGoogleTokenCache);
it("never reuses an access token for different credentials", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async (_url, init) =>
      Response.json({ access_token: new URLSearchParams(String(init?.body)).get("refresh_token"), expires_in: 3600 }),
    );
  expect(await googleAccessToken(account, fetch)).toBe("account-a");
  expect(await googleAccessToken({ ...account }, fetch)).toBe("account-a");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(await googleAccessToken({ ...account, refreshToken: "account-b" }, fetch)).toBe("account-b");
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: "error", signal: expect.any(AbortSignal) });
});
it.each([
  { access_token: 123, expires_in: 3600 },
  { access_token: "token", expires_in: "3600" },
  { access_token: "token", expires_in: -1 },
])("rejects malformed token data %#", async (body) => {
  await expect(googleAccessToken(account, vi.fn().mockResolvedValue(Response.json(body)))).rejects.toThrow();
});
it("does not expose provider error bodies", async () => {
  await expect(
    googleAccessToken(
      account,
      vi.fn().mockResolvedValue(Response.json({ error_description: "private-data" }, { status: 400 })),
    ),
  ).rejects.toThrow("google token refresh failed (HTTP 400)");
});
