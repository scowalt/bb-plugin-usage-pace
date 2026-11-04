import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createClaudeUsageReader, createCodexUsageReader } from "./subscription-usage";
import { sourceUsageSchema } from "./usage-source-contract";

const NOW = Date.parse("2026-11-04T16:00:00Z");
const hostUsageSchema = z.object({ accountKey: z.string().min(1).nullable(), usage: sourceUsageSchema });

describe("Claude usage reader", () => {
  const credentials = (overrides: Record<string, unknown> = {}) => JSON.stringify({
    claudeAiOauth: { accessToken: "synthetic-token", expiresAt: NOW + 3_600_000, subscriptionType: "max", rateLimitTier: "default_claude_max_20x", ...overrides },
  });
  const account = JSON.stringify({ oauthAccount: { emailAddress: "one@example.test", accountUuid: "uuid-1" } });
  const body = {
    five_hour: { utilization: 12.4, resets_at: "2026-11-04T18:00:00+00:00" },
    seven_day: { utilization: 40, resets_at: "2026-11-09T00:00:00+00:00" },
    limits: [
      { kind: "weekly_scoped", scope: { model: { display_name: "Opus" } }, percent: 55, resets_at: "2026-11-09T00:00:00Z" },
      { kind: "weekly_scoped", scope: { model: { display_name: "opus" } }, percent: 99, resets_at: "2026-11-09T00:00:00Z" },
      { kind: "other", percent: 5 },
      "unexpected",
    ],
  };
  function setup(overrides: Partial<Parameters<typeof createClaudeUsageReader>[0]> = {}, response: () => Response = () => Response.json(body)) {
    const request = vi.fn<typeof fetch>(async () => response());
    const read = createClaudeUsageReader({
      readAuth: async () => credentials(), readAccount: async () => account, installed: async () => true,
      fetch: request, now: () => NOW, ...overrides,
    });
    return { read, request };
  }

  it("reads session, weekly and per-model windows with the provider-issued account key", async () => {
    const { read, request } = setup();
    const result = await read();
    expect(hostUsageSchema.parse(result)).toEqual(result);
    expect(result).toEqual({
      accountKey: "anthropic:account:uuid-1",
      usage: {
        status: "ok", accountEmail: "one@example.test", planLabel: "Max (20x)", plan: { id: "max", multiplier: 20 },
        windows: [
          { kind: "five-hour", id: "0:Current session", label: "Current session", usedPercent: 12, resetsAt: "2026-11-04T18:00:00.000Z", model: null, cost: null },
          { kind: "weekly", id: "1:Weekly limit", label: "Weekly limit", usedPercent: 40, resetsAt: "2026-11-09T00:00:00.000Z", model: null, cost: null },
          { kind: "weekly", id: "2:Opus", label: "Opus", usedPercent: 55, resetsAt: "2026-11-09T00:00:00.000Z", model: "opus", cost: null },
        ],
      },
    });
    expect(request).toHaveBeenCalledWith("https://api.anthropic.com/api/oauth/usage", expect.objectContaining({
      method: "GET", redirect: "error", headers: expect.objectContaining({ Authorization: "Bearer synthetic-token" }),
    }));
  });

  it("reports a missing Claude Code setup as not installed and a missing login as unauthenticated", async () => {
    const missing = async () => { throw new Error("ENOENT"); };
    expect((await setup({ readAuth: missing, installed: async () => false }).read()).usage.status).toBe("not_installed");
    const signedOut = setup({ readAuth: missing });
    expect((await signedOut.read()).usage.status).toBe("unauthenticated");
    expect(signedOut.request).not.toHaveBeenCalled();
  });

  it("reports an expired login without contacting Anthropic", async () => {
    const { read, request } = setup({ readAuth: async () => credentials({ expiresAt: NOW - 1 }) });
    expect(await read()).toMatchObject({ accountKey: "anthropic:account:uuid-1", usage: { status: "expired", accountEmail: "one@example.test" } });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    [401, { status: "expired" }],
    [429, { status: "error", message: expect.stringContaining("does not mean your Claude limit is exhausted") }],
    [500, { status: "error", message: "Claude usage request failed (HTTP 500)." }],
  ])("maps HTTP %i to a usage state", async (status, usage) => {
    const { read } = setup({}, () => new Response("{}", { status }));
    expect((await read()).usage).toMatchObject(usage);
  });

  it("reports a malformed response or network failure as an error, never as zero usage", async () => {
    expect((await setup({}, () => Response.json({ five_hour: "bad" })).read()).usage).toMatchObject({ status: "error", message: "Claude usage response was malformed." });
    const offline = setup({ fetch: async () => { throw new Error("network down"); } });
    expect((await offline.read()).usage).toMatchObject({ status: "error", message: "network down" });
  });

  it("leaves the account key unknown without a local account record", async () => {
    const { read } = setup({ readAccount: async () => { throw new Error("ENOENT"); } });
    expect(await read()).toMatchObject({ accountKey: null, usage: { status: "ok", accountEmail: null } });
  });
});

describe("Codex usage reader", () => {
  const jwt = (claims: Record<string, unknown>) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
  const auth = (claims: Record<string, unknown> = {}) => JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: jwt({ exp: NOW / 1000 + 3600, email: "one@example.test", ...claims }), account_id: "acct-1" },
  });
  const body = {
    plan_type: "pro",
    rate_limit: {
      primary_window: { used_percent: 21.6, reset_at: NOW / 1000 + 3600, limit_window_seconds: 18_000 },
      secondary_window: { used_percent: 64, reset_at: NOW / 1000 + 86_400, limit_window_seconds: 604_800 },
    },
  };
  function setup(overrides: Partial<Parameters<typeof createCodexUsageReader>[0]> = {}, response: () => Response = () => Response.json(body)) {
    const request = vi.fn<typeof fetch>(async () => response());
    const read = createCodexUsageReader({ readAuth: async () => auth(), installed: async () => true, fetch: request, now: () => NOW, ...overrides });
    return { read, request };
  }

  it("reads session and weekly windows with the ChatGPT account key", async () => {
    const { read, request } = setup();
    const result = await read();
    expect(hostUsageSchema.parse(result)).toEqual(result);
    expect(result).toEqual({
      accountKey: "openai:chatgpt:acct-1",
      usage: {
        status: "ok", accountEmail: "one@example.test", planLabel: "Pro", plan: { id: "pro", multiplier: null },
        windows: [
          { kind: "five-hour", id: "0:Current session", label: "Current session", usedPercent: 22, resetsAt: new Date(NOW + 3_600_000).toISOString(), model: null, cost: null },
          { kind: "weekly", id: "1:Weekly limit", label: "Weekly limit", usedPercent: 64, resetsAt: new Date(NOW + 86_400_000).toISOString(), model: null, cost: null },
        ],
      },
    });
    expect(request).toHaveBeenCalledWith("https://chatgpt.com/backend-api/wham/usage", expect.objectContaining({
      headers: expect.objectContaining({ "chatgpt-account-id": "acct-1" }),
    }));
  });

  it("distinguishes not installed, signed out, API-key and expired logins without a request", async () => {
    const missing = async () => { throw new Error("ENOENT"); };
    expect((await setup({ readAuth: missing, installed: async () => false }).read()).usage.status).toBe("not_installed");
    expect((await setup({ readAuth: missing }).read()).usage.status).toBe("unauthenticated");
    const apiKey = setup({ readAuth: async () => JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-test" }) });
    expect((await apiKey.read()).usage).toMatchObject({ status: "error", message: expect.stringContaining("API key") });
    const expired = setup({ readAuth: async () => auth({ exp: NOW / 1000 - 1 }) });
    expect(await expired.read()).toMatchObject({ accountKey: "openai:chatgpt:acct-1", usage: { status: "expired" } });
    expect(apiKey.request).not.toHaveBeenCalled();
    expect(expired.request).not.toHaveBeenCalled();
  });

  it("maps HTTP and response failures to error states", async () => {
    expect((await setup({}, () => new Response("{}", { status: 401 })).read()).usage.status).toBe("expired");
    expect((await setup({}, () => new Response("{}", { status: 503 })).read()).usage).toMatchObject({ status: "error", message: "Codex usage request failed (HTTP 503)." });
    expect((await setup({}, () => Response.json({ rate_limit: "bad" })).read()).usage).toMatchObject({ status: "error", message: "Codex usage response was malformed." });
  });
});
