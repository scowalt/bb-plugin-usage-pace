import { afterEach, describe, expect, it, vi } from "vitest";
import { NOW, at, makeAccount } from "../tests/usage-fixtures";
import { ANTIGRAVITY_PROVIDER_ID } from "./antigravity-provider";
import { GEMINI_NEON, OPUS, parseEffortBands, type UsageReading } from "./autopilot";
import { COLD_WAIT_MS, RUNNABILITY_FRESH_MS, RUNNABILITY_RETRY_MS, createAutopilot } from "./autopilot-shell";

afterEach(() => {
  vi.useRealTimers();
});

const claude = makeAccount({
  accountKey: "a", weight: 10, hosts: [{ id: "mac", name: "Mac" }], signedOutHosts: [],
  windows: [{ id: "weekly", kind: "weekly", model: null, label: "Weekly limit", weekly: true, usedPercent: 50, resetsAt: at(84) }],
});
const gemini = makeAccount({
  id: ANTIGRAVITY_PROVIDER_ID, accountKey: null, weight: null, plan: null, hosts: [{ id: "mac", name: "Mac" }], signedOutHosts: [],
  windows: [{ id: "gemini-weekly", kind: "weekly", model: "Gemini Models", label: "Gemini Models · Weekly", weekly: true, usedPercent: 5, resetsAt: at(84) }],
});
const usage: UsageReading = { accounts: [claude, gemini], fetchedAt: new Date(NOW).toISOString() };

const noSources = { providerId: null, model: null, reasoningLevel: null };
const appRequest = { origin: "app", hostId: "mac", requested: { providerId: null, model: null, reasoningLevel: null }, sources: noSources };
const listsNeon = { modelLoadError: null, models: [{ model: GEMINI_NEON.model }] };

function setup(overrides: { models?: () => Promise<unknown>; list?: () => Promise<unknown>; readUsage?: () => Promise<UsageReading | null>; enabled?: boolean } = {}) {
  const clock = { now: NOW };
  const bb = {
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    sdk: {
      providers: {
        list: vi.fn(overrides.list ?? (async () => [{ id: GEMINI_NEON.providerId, available: true }])),
        models: vi.fn(overrides.models ?? (async () => listsNeon)),
      },
      system: { config: vi.fn(async () => ({ primaryHostId: "server" })) },
    },
  };
  const readUsage = vi.fn(overrides.readUsage ?? (async () => usage));
  const controller = new AbortController();
  const autopilot = createAutopilot({
    bb: bb as never, signal: controller.signal, now: () => clock.now, readUsage,
    settings: () => ({ enabled: overrides.enabled ?? true, bands: parseEffortBands("").bands }),
  });
  return { autopilot, bb, readUsage, clock };
}

describe("the autopilot shell", () => {
  it("chooses Gemini Neon when it is cheaper and runs on the machine", async () => {
    const { autopilot, bb } = setup();
    const choice = await autopilot.choose(appRequest);
    expect(choice).toMatchObject({ providerId: GEMINI_NEON.providerId, model: GEMINI_NEON.model, reasoningLevel: "high" });
    expect(bb.sdk.providers.models).toHaveBeenCalledWith(expect.objectContaining({ hostId: "mac", providerId: GEMINI_NEON.providerId }));
  });

  it("reads nothing and chooses nothing when autopilot is off or the request names a model", async () => {
    const off = setup({ enabled: false });
    expect(await off.autopilot.choose(appRequest)).toBeNull();
    expect(off.readUsage).not.toHaveBeenCalled();
    expect(off.bb.sdk.providers.list).not.toHaveBeenCalled();
    const named = setup();
    expect(await named.autopilot.choose({ ...appRequest, origin: "cli", requested: { providerId: "pi", model: null, reasoningLevel: null }, sources: { ...noSources, providerId: "explicit" } })).toBeNull();
    expect(named.bb.sdk.providers.list).not.toHaveBeenCalled();
  });

  it("asks the primary machine when the request has no host", async () => {
    const { autopilot, bb } = setup();
    await autopilot.choose({ ...appRequest, hostId: null });
    expect(bb.sdk.providers.models).toHaveBeenCalledWith(expect.objectContaining({ hostId: "server" }));
  });

  it("falls back to Opus when Antigravity is missing or does not list the model", async () => {
    const missing = setup({ list: async () => [] });
    expect((await missing.autopilot.choose(appRequest))?.providerId).toBe(OPUS.providerId);
    const unlisted = setup({ models: async () => ({ modelLoadError: null, models: [] }) });
    const choice = await unlisted.autopilot.choose(appRequest);
    expect(choice?.providerId).toBe(OPUS.providerId);
    expect(choice?.reason).toContain("does not list gemini-4-neon");
  });

  it("reuses a fresh machine check and refreshes an old one in the background", async () => {
    const { autopilot, bb, clock } = setup();
    await autopilot.choose(appRequest);
    await autopilot.choose(appRequest);
    expect(bb.sdk.providers.models).toHaveBeenCalledTimes(1);
    clock.now += RUNNABILITY_FRESH_MS + 1;
    bb.sdk.providers.models.mockImplementation(async () => ({ modelLoadError: { code: "missing_executable" }, models: [] }));
    expect((await autopilot.choose(appRequest))?.providerId).toBe(GEMINI_NEON.providerId);
    await vi.waitFor(() => expect(bb.sdk.providers.models).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => expect((await autopilot.choose(appRequest))?.providerId).toBe(OPUS.providerId));
  });

  it("checks again soon after Gemini Neon could not start, and waits for that check", async () => {
    const hostDown = { modelLoadError: { code: "failed", detail: "Host is not connected" }, models: [] };
    const { autopilot, bb, clock } = setup({ models: async () => hostDown });
    const first = await autopilot.choose(appRequest);
    expect(first?.providerId).toBe(OPUS.providerId);
    expect(first?.reason).toContain("Antigravity cannot start on this machine (failed: Host is not connected)");
    bb.sdk.providers.models.mockImplementation(async () => listsNeon);
    clock.now += RUNNABILITY_RETRY_MS - 1;
    expect((await autopilot.choose(appRequest))?.providerId).toBe(OPUS.providerId);
    expect(bb.sdk.providers.models).toHaveBeenCalledTimes(1);
    clock.now += 2;
    expect((await autopilot.choose(appRequest))?.providerId).toBe(GEMINI_NEON.providerId);
    expect(bb.sdk.providers.models).toHaveBeenCalledTimes(2);
  });

  it("decides as unknown instead of waiting past the cold-cache budget", async () => {
    vi.useFakeTimers();
    const never = new Promise<never>(() => undefined);
    const { autopilot } = setup({ models: () => never, readUsage: () => never });
    const pending = autopilot.choose(appRequest);
    await vi.advanceTimersByTimeAsync(COLD_WAIT_MS);
    const choice = await pending;
    expect(choice).toMatchObject({ providerId: OPUS.providerId, reasoningLevel: "high" });
    expect(choice?.reason).toContain("overall pace unknown");
  });

  it("logs and decides as unknown when usage cannot be read", async () => {
    const { autopilot, bb } = setup({ readUsage: async () => { throw new Error("collector down"); } });
    const choice = await autopilot.choose(appRequest);
    expect(choice?.providerId).toBe(OPUS.providerId);
    expect(bb.log.warn).toHaveBeenCalledWith(expect.stringContaining("collector down"));
  });

  it("logs and falls back to Opus when the machine check fails", async () => {
    const { autopilot, bb } = setup({ models: async () => { throw new Error("host offline"); } });
    const choice = await autopilot.choose(appRequest);
    expect(choice?.providerId).toBe(OPUS.providerId);
    expect(choice?.reason).toContain("could not check Antigravity on this machine yet");
    expect(bb.log.warn).toHaveBeenCalledWith(expect.stringContaining("host offline"));
  });
});
