import { describe, expect, it, vi } from "vitest";
import { createClaudeLimitResetsReader } from "./claude-limit-resets";
import { bankedResetsSchema } from "./banked-resets-contract";

const NOW = Date.parse("2026-10-07T20:00:00Z");
const MINUTE = 60_000;
const secret = "synthetic-access-token";
const credentials = (token = secret, overrides: Record<string, unknown> = {}) => JSON.stringify({
  claudeAiOauth: { accessToken: token, expiresAt: NOW + 86_400_000, scopes: ["user:profile"], ...overrides },
});
const profile = (email = "one@example.test") => ({ account: { uuid: "account", email }, organization: { uuid: "org" } });
const grant = (overrides: Record<string, unknown> = {}) => ({
  id: "example-grant", label: "Model launch reset", resets_total: 1, resets_left: 1,
  starts_at: "2026-09-22T16:00:00+00:00", ends_at: "2026-10-22T16:00:00+00:00",
  clears: ["five_hour", "seven_day", "seven_day_overage_included"], paused: false,
  usable_now: true, use_requires_limit: false, blocking: [], ...overrides,
});
const notAtWall = { eligible: false, ineligible_reason: "not_at_wall", available: false, arm: null, next_available_at: null, resets_per_week: 1 };
const usage = (grants: unknown[] = [grant()], session: unknown = notAtWall) => ({
  cedar_ember: { eligible: true, grants }, juniper_tide: session,
});
function setup(body: unknown = usage()) {
  let now = NOW;
  let auth = credentials();
  const readAuth = vi.fn(async () => auth);
  const readVersion = vi.fn(async () => "2.1.291 (Claude Code)\n");
  const request = vi.fn<typeof fetch>(async input => String(input).endsWith("/profile") ? Response.json(profile()) : Response.json(body));
  const read = createClaudeLimitResetsReader({ readAuth, readVersion, fetch: request, now: () => now });
  return { read, readAuth, readVersion, request, setAuth: (value: string) => { auth = value; }, setNow: (value: number) => { now = value; } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it("reads the verified full-reset grant and keeps conditional availability separate", async () => {
  const { read } = setup();
  const result = await read();
  expect(bankedResetsSchema.parse(result)).toEqual(result);
  expect(result).toMatchObject({
    status: "ok", accountEmail: "one@example.test", availableCount: 1, fetchedAt: new Date(NOW).toISOString(),
    credits: [{ title: "Model launch reset", remaining: 1, scope: "full", expiresAt: "2026-10-22T16:00:00.000Z", usableNow: true }],
    sessionReset: { availability: "unavailable", reason: "not_at_wall", nextAvailableAt: null },
  });
});

it("only makes bounded read-only requests to fixed first-party endpoints, with the compatibility user agent", async () => {
  const { read, request } = setup();
  const result = await read();
  expect(request.mock.calls.map(([url]) => url)).toEqual([
    "https://api.anthropic.com/api/oauth/usage?at_wall=1&skip_spend=1",
    "https://api.anthropic.com/api/oauth/profile",
  ]);
  for (const [, options] of request.mock.calls) {
    expect(options).toMatchObject({ method: "GET", redirect: "error", signal: expect.any(AbortSignal) });
    expect(options?.body).toBeUndefined();
    const headers = new Headers(options?.headers);
    expect(headers.get("User-Agent")).toBe("claude-cli/2.1.291 (external, cli) bb-usage-pace");
    expect(headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
    expect(headers.get("Authorization")).toBe(`Bearer ${secret}`);
  }
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(result)).not.toContain('"uuid"');
});

it("sums remaining uses rather than grant records and classifies scope without trusting the label", async () => {
  const { read } = setup(usage([
    grant({ id: "full", resets_total: 5, resets_left: 3, usable_now: false }),
    grant({ id: "session", label: "Full reset misleading label", resets_total: 2, resets_left: 2, clears: ["five_hour"], ends_at: "2026-10-08T00:00:00Z" }),
    grant({ id: "model", label: null, clears: ["seven_day_future_model"], starts_at: null, ends_at: null }),
  ]));
  const result = await read();
  expect(result.availableCount).toBe(6);
  expect(result.credits.map(credit => [credit.id, credit.scope, credit.remaining])).toEqual([
    ["session", "five-hour", 2], ["full", "full", 3], ["model", "other", 1],
  ]);
  expect(result.credits[1]?.usableNow).toBe(false);
  expect(result.credits[2]).toMatchObject({ title: "Saved reset", expiresAt: null });
});

it("excludes paused, spent, future and expired grants from the current saved balance", async () => {
  const { read } = setup(usage([
    grant(), grant({ id: "paused", paused: true }), grant({ id: "spent", resets_left: 0 }),
    grant({ id: "future", starts_at: "2026-10-08T00:00:00Z" }),
    grant({ id: "expired", ends_at: new Date(NOW).toISOString() }),
  ]));
  expect(await read()).toMatchObject({ availableCount: 1, credits: [{ id: "example-grant" }] });
});

it("reports a zero only for a valid, eligible empty inventory", async () => {
  expect(await setup(usage([])).read()).toMatchObject({ status: "ok", availableCount: 0, credits: [] });
});

it.each([
  {}, { cedar_ember: null }, { cedar_ember: { eligible: false, ineligible_reason: "surface", grants: [] } },
  { cedar_ember: { eligible: false, ineligible_reason: "no_grant", grants: [] } },
  { cedar_ember: { eligible: true } },
  usage([grant({ resets_left: "1" })]), usage([grant({ resets_left: -1 })]),
  usage([grant({ resets_left: 0.5 })]), usage([grant({ resets_left: 2 })]),
  usage([grant({ ends_at: "tomorrow" })]), usage([grant({ paused: undefined })]),
  usage([grant({ starts_at: "bad" })]), usage([grant({ clears: "everything" })]),
  usage(Array.from({ length: 201 }, (_, i) => grant({ id: String(i) }))),
])("never turns an absent, gated or malformed inventory into zero (%#)", async body => {
  expect(await setup(body).read()).toMatchObject({ status: "unsupported", availableCount: null, credits: [] });
});

it.each([
  usage([grant(), grant()]),
  usage([grant({ starts_at: "2026-10-23T00:00:00Z" })]),
  null, "unexpected",
])("rejects contradictory or non-object data without a guessed balance (%#)", async body => {
  expect(await setup(body).read()).toMatchObject({ status: "error", availableCount: null });
});

const syntheticAvailableSession = { eligible: true, arm: "reset", available: true, next_available_at: null, resets_per_week: 99 };
it("does not add available sessions or resets_per_week to the saved count", async () => {
  expect(await setup(usage([], syntheticAvailableSession)).read()).toMatchObject({ availableCount: 0, sessionReset: { availability: "available" } });
});
it("can report conditional availability even if the saved-grant inventory is hidden", async () => {
  expect(await setup({ cedar_ember: null, juniper_tide: syntheticAvailableSession }).read()).toMatchObject({
    status: "unsupported", availableCount: null, sessionReset: { availability: "available" },
  });
});
it.each([null, undefined, {}, { ...syntheticAvailableSession, arm: "control" }, { ...syntheticAvailableSession, available: undefined },
  { ...notAtWall, ineligible_reason: "surface" }, { ...notAtWall, ineligible_reason: "unavailable" },
  { ...syntheticAvailableSession, next_available_at: "bad" },
])("treats missing or inaccessible session status as unknown without hiding a valid balance (%#)", async session => {
  const body = { ...usage(), juniper_tide: session };
  expect(await setup(body).read()).toMatchObject({ status: "ok", availableCount: 1, sessionReset: { availability: "unknown" } });
});
it("reports next availability separately, never as a credit expiration", async () => {
  const at = new Date(NOW + MINUTE).toISOString();
  const { read } = setup(usage([], { ...syntheticAvailableSession, available: false, next_available_at: at }));
  expect(await read()).toMatchObject({ availableCount: 0, credits: [], sessionReset: { availability: "unavailable", nextAvailableAt: at } });
});

it.each([
  ["not json", "unauthenticated"], ["{}", "unauthenticated"],
  [credentials(secret, { expiresAt: NOW }), "unauthenticated"],
  [credentials(secret, { scopes: ["user:inference"] }), "unsupported"],
])("does not contact Claude for missing, expired or insufficient authentication (%#)", async (auth, status) => {
  const { read, setAuth, request } = setup();
  setAuth(auth!);
  expect(await read()).toMatchObject({ status, availableCount: null });
  expect(request).not.toHaveBeenCalled();
});
it("invalidates prior inventory when credentials disappear", async () => {
  const { read, readAuth, request } = setup();
  await read();
  readAuth.mockRejectedValueOnce(new Error("file missing"));
  expect(await read()).toMatchObject({ status: "unauthenticated", availableCount: null });
  expect(request).toHaveBeenCalledTimes(2);
  await read();
  expect(request).toHaveBeenCalledTimes(4);
});
it("refuses to guess the compatibility version", async () => {
  const { read, readVersion, request } = setup();
  readVersion.mockResolvedValue("unexpected output");
  expect(await read()).toMatchObject({ status: "unsupported", availableCount: null });
  expect(request).not.toHaveBeenCalled();
});
it.each([[401, "unauthenticated"], [403, "unsupported"], [429, "error"], [503, "error"]])("handles HTTP %s without reading error bodies into the UI", async (status, expected) => {
  const { read, request } = setup();
  request.mockImplementation(async () => new Response(secret, { status: Number(status) }));
  const result = await read();
  expect(result).toMatchObject({ status: expected, availableCount: null });
  expect(JSON.stringify(result)).not.toContain(secret);
});
it.each(["profile", "usage"])("requires a valid %s response even if the other request succeeds", async broken => {
  const { read, request } = setup();
  request.mockImplementation(async url => String(url).includes(`/${broken}`) ? new Response("not json") : Response.json(broken === "profile" ? usage() : profile()));
  expect(await read()).toMatchObject({ status: "error", availableCount: null });
});
it("rejects usage without a verified profile identity", async () => {
  const { read, request } = setup();
  request.mockImplementation(async url => Response.json(String(url).endsWith("/profile") ? { account: { email: "one@example.test" } } : usage()));
  expect(await read()).toMatchObject({ status: "error", availableCount: null });
});
it("bounds provider bodies and does not surface raw transport errors", async () => {
  const { read, request } = setup();
  request.mockImplementation(async () => new Response("x".repeat(1024 * 1024 + 1)));
  expect(await read()).toMatchObject({ status: "error", availableCount: null });
  request.mockRejectedValue(new Error(secret));
  expect(JSON.stringify(await read(true))).not.toContain(secret);
});

describe("host-local caching", () => {
  it("shares in-flight reads, caches for five minutes, and bypasses on force without re-reading identity", async () => {
    const { read, request, setNow } = setup();
    const [first, second] = await Promise.all([read(), read()]);
    expect(first).toEqual(second);
    expect(request).toHaveBeenCalledTimes(2);
    await read();
    expect(request).toHaveBeenCalledTimes(2);
    await read(true);
    expect(request).toHaveBeenCalledTimes(3);
    setNow(NOW + 5 * MINUTE);
    await read();
    expect(request).toHaveBeenCalledTimes(4);
  });
  it.each(["start", "end", "session"])("invalidates at the next %s boundary", async boundary => {
    const at = new Date(NOW + MINUTE).toISOString();
    const body = boundary === "session" ? usage([], { ...syntheticAvailableSession, available: false, next_available_at: at })
      : usage([grant(boundary === "start" ? { starts_at: at } : { ends_at: at })]);
    const { read, request, setNow } = setup(body);
    await read();
    setNow(NOW + MINUTE);
    const next = await read();
    expect(request).toHaveBeenCalledTimes(3);
    if (boundary !== "session") expect(next.availableCount).toBe(boundary === "start" ? 1 : 0);
  });
  it("does not fall back to a stale cached balance after a forced read fails", async () => {
    const { read, request } = setup();
    await read();
    request.mockResolvedValueOnce(new Response(null, { status: 503 }));
    expect(await read(true)).toMatchObject({ status: "error", availableCount: null });
    expect(await read()).toMatchObject({ status: "ok", availableCount: 1 });
    expect(request).toHaveBeenCalledTimes(4);
  });
  it("checks token expiry even while a successful snapshot is cached", async () => {
    const { read, request, setAuth, setNow } = setup();
    setAuth(credentials(secret, { expiresAt: NOW + MINUTE }));
    await read();
    setNow(NOW + MINUTE);
    expect(await read()).toMatchObject({ status: "unauthenticated", availableCount: null });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("isolates token changes and does not let late reads overwrite a new account's cache", async () => {
    const { read, setAuth, request } = setup();
    const oldUsage = deferred<Response>();
    request.mockImplementation(async (url, options) => {
      const old = new Headers(options?.headers).get("Authorization") === `Bearer ${secret}`;
      if (String(url).endsWith("/profile")) return Response.json(profile(old ? "one@example.test" : "two@example.test"));
      return old ? oldUsage.promise : Response.json(usage([grant({ resets_total: 2, resets_left: 2 })]));
    });
    const first = read();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    setAuth(credentials("other-token"));
    expect(await read()).toMatchObject({ availableCount: 2, accountEmail: "two@example.test" });
    oldUsage.resolve(Response.json(usage()));
    expect(await first).toMatchObject({ availableCount: 1, accountEmail: "one@example.test" });
    expect(await read()).toMatchObject({ availableCount: 2, accountEmail: "two@example.test" });
    expect(request).toHaveBeenCalledTimes(4);
  });
});

it("honors cancellation before authentication and during the HTTP read", async () => {
  const { read, readAuth, request } = setup();
  const aborted = new AbortController();
  aborted.abort();
  expect(await read(false, aborted.signal)).toMatchObject({ status: "error", availableCount: null });
  expect(readAuth).not.toHaveBeenCalled();
  const controller = new AbortController();
  request.mockImplementation(async (_url, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
  }));
  const pending = read(false, controller.signal);
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  controller.abort();
  expect(await pending).toMatchObject({ status: "error", availableCount: null });
});
