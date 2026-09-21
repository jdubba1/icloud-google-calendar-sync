import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
const mocks = vi.hoisted(() => ({ createServer: vi.fn(), writeFileSync: vi.fn() }));
vi.mock("node:http", () => ({ createServer: mocks.createServer }));
vi.mock("node:fs", () => ({ existsSync: vi.fn(), readFileSync: vi.fn(), writeFileSync: mocks.writeFileSync }));
const argv = process.argv;
const exitCode = process.exitCode;
afterEach(() => {
  process.argv = argv;
  process.exitCode = exitCode;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("binds OAuth to loopback, rejects wrong state, and exchanges the PKCE verifier", async () => {
  vi.resetModules();
  process.argv = [
    "node",
    "cli",
    "auth",
    "google",
    "--client-id",
    "test-client",
    "--client-secret",
    "test-secret",
    "--out",
    "tokens.json",
  ];
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const close = vi.fn();
  const listen = vi.fn();
  mocks.createServer.mockImplementation((callback) => {
    const server = { close, listen, on: vi.fn() };
    listen.mockImplementation(() => {
      const text = String(log.mock.calls[0][0]);
      const url = new URL(text.match(/https:\/\/\S+/)![0]);
      expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:8765/");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      const rejected = { writeHead: vi.fn().mockReturnThis(), end: vi.fn() };
      callback({ method: "GET", url: "/?code=attacker&state=wrong" }, rejected);
      expect(rejected.writeHead).toHaveBeenCalledWith(400);
      expect(close).not.toHaveBeenCalled();
      callback({ method: "GET", url: `/?code=valid&state=${url.searchParams.get("state")}` }, { end: vi.fn() });
    });
    return server;
  });
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
    const params = new URLSearchParams(String(init?.body));
    const url = new URL(String(log.mock.calls[0][0]).match(/https:\/\/\S+/)![0]);
    expect(params.get("code")).toBe("valid");
    expect(createHash("sha256").update(params.get("code_verifier")!).digest("base64url")).toBe(
      url.searchParams.get("code_challenge"),
    );
    return Response.json({ refresh_token: "test-refresh" });
  });
  vi.stubGlobal("fetch", fetch);
  await import("../src/cli.js");
  await vi.waitFor(() =>
    expect(mocks.writeFileSync).toHaveBeenCalledWith("tokens.json", expect.any(String), { mode: 0o600, flag: "wx" }),
  );
  expect(listen).toHaveBeenCalledWith(8765, "127.0.0.1");
  expect(close).toHaveBeenCalledTimes(1);
});
