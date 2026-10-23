import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import plugin, { rpcContract } from "./server";
import { bankedResetsHostContract } from "./lib/banked-resets-host-contract";
import type { BankedResets } from "./lib/banked-resets-contract";
import { usageCliSchema } from "./lib/usage-cli";
import { usageForDisplay } from "./lib/usage-scope";

const inventory: BankedResets = { status: "ok", availableCount: 0, credits: [], accountEmail: "one@example.test", fetchedAt: "2026-10-07T20:00:00Z", message: null };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanups.splice(0)) await dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function setup() {
  const callHost = vi.fn(async ({ input }: { input: unknown }) => {
    const parsed = bankedResetsHostContract.readBankedResets.input.parse(input);
    return parsed.providerId === "claude-code"
      ? { ...inventory, sessionReset: { availability: "unavailable", reason: "not_at_wall", nextAvailableAt: null } }
      : inventory;
  });
  const { bb, harness } = createFakePluginHost({
    pluginId: "usage-pace", settings: { grokUsage: false },
    sdk: { hosts: { list: async () => [makeHostResponse({ id: "remote", status: "connected" }), makeHostResponse({ id: "offline", status: "disconnected" })] }, system: { config: async () => ({ primaryHostId: "remote" }) } },
    experimental_callHostRpc: callHost,
  });
  cleanups.push(() => harness.lifecycle.dispose());
  await plugin(bb);
  return { harness, callHost };
}

describe("reset RPC host routing", () => {
  it("dispatches Claude to the selected host and preserves the Codex default", async () => {
    const { harness, callHost } = await setup();
    expect(await harness.behavior.callRpc("getBankedResets", { hostId: "remote" })).toEqual(inventory);
    expect(callHost).toHaveBeenLastCalledWith(expect.objectContaining({ hostId: "remote", method: "readBankedResets", input: { force: false, providerId: "codex" } }));
    expect(await harness.behavior.callRpc("getBankedResets", { hostId: "remote", providerId: "claude-code", force: true })).toMatchObject({ sessionReset: { availability: "unavailable" } });
    expect(callHost).toHaveBeenLastCalledWith(expect.objectContaining({ hostId: "remote", method: "readBankedResets", input: { force: true, providerId: "claude-code" }, signal: expect.any(AbortSignal) }));
  });
  it.each(["offline", "missing"])("returns unknown without reading a %s host", async hostId => {
    const { harness, callHost } = await setup();
    expect(await harness.behavior.callRpc("getBankedResets", { hostId, providerId: "claude-code" })).toMatchObject({ status: "error", availableCount: null });
    expect(callHost).not.toHaveBeenCalled();
  });
  it("rejects unsupported providers and extraneous input before reaching the host", async () => {
    const { harness, callHost } = await setup();
    await expect(harness.behavior.callRpc("getBankedResets", { hostId: "remote", providerId: "other" })).rejects.toThrow();
    await expect(harness.behavior.callRpc("getBankedResets", { hostId: "remote", url: "https://other.test" })).rejects.toThrow();
    expect(callHost).not.toHaveBeenCalled();
  });
  it("returns unknown after a host failure rather than a zero balance", async () => {
    const { harness, callHost } = await setup();
    callHost.mockRejectedValueOnce(new Error("offline"));
    expect(await harness.behavior.callRpc("getBankedResets", { hostId: "remote", providerId: "claude-code" })).toMatchObject({ status: "error", availableCount: null });
  });
  it("keeps existing --resets CLI output and primary-host Codex behavior unchanged", async () => {
    const { harness, callHost } = await setup();
    const result = await harness.behavior.runCli(["--resets", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout ?? "")).toEqual({ hostId: "remote", ...inventory, truncated: false });
    expect(callHost).toHaveBeenCalledWith(expect.objectContaining({ input: { providerId: "codex", force: false } }));
  });
});

async function setupUsage(settings: { serverOnly?: boolean } = {}) {
  const scope: { hosts: ReturnType<typeof makeHostResponse>[]; primaryHostId: string | null } = {
    hosts: [makeHostResponse({ id: "remote", name: "Remote", status: "connected" }), makeHostResponse({ id: "server", name: "Server", status: "connected" })],
    primaryHostId: "server",
  };
  const listHosts = vi.fn(async () => scope.hosts);
  const config = vi.fn(async () => ({ primaryHostId: scope.primaryHostId }));
  const listProviders = vi.fn(async () => [{ id: "claude-code", displayName: "Claude Code" }]);
  const usageLimits = vi.fn(async (_input: { hostId: string }) => ({
    "claude-code": { status: "ok", accountEmail: "shared@example.test", planLabel: "Max", windows: [
      { label: "Weekly limit", usedPercent: 52, resetsAt: "2026-10-15T12:00:00Z" },
    ] },
  }));
  const { bb, harness } = createFakePluginHost({
    pluginId: "usage-pace", settings: { grokUsage: false, ...settings },
    sdk: { hosts: { list: listHosts }, providers: { list: listProviders }, system: { config, usageLimits }, plugins: {
      experimental_discoverRpc: async () => [{ pluginId: "provider-claude-code", displayName: "Claude Code provider" }],
      callRpc: async ({ method, input }: { method: string; input: { resourceId?: string } }) => {
        if (method.endsWith("listResources")) return { resources: scope.hosts.map(host => ({
          id: host.id, providerId: "claude-code", accountKey: null, label: "Claude Code", scope: { kind: "host", hostId: host.id, hostName: host.name },
        })) };
        const usage = (await usageLimits({ hostId: input.resourceId! }))["claude-code"];
        return { accountKey: null, observedAt: Date.now(), usage: { ...usage, plan: null, windows: usage.windows.map((window, index) => ({ ...window, id: String(index), kind: "weekly", model: null })) } };
      },
    } },
  });
  cleanups.push(() => harness.lifecycle.dispose());
  await plugin(bb);
  const getUsage = async () => rpcContract.getUsage.output.parse(await harness.behavior.callRpc("getUsage", {}));
  return { harness, scope, listHosts, config, listProviders, usageLimits, getUsage };
}

describe("account CLI schema", () => {
  it("validates accounts, per-window pace, pools, and the deprecated providers alias", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-12T12:00:00Z") });
    const { harness } = await setupUsage();
    const result = await harness.behavior.runCli(["--json"]);
    const output = usageCliSchema.parse(JSON.parse(result.stdout ?? ""));
    expect(output.accounts).toEqual(output.providers);
    expect(output.accounts).toHaveLength(2);
    expect(output.accounts[0]).toMatchObject({ accountKey: null, sources: [expect.objectContaining({ pluginId: "provider-claude-code" })], hosts: [expect.any(Object)], observedAt: expect.any(Number) });
    expect(output.accounts[0]?.windows[0]?.pace?.ratio).toBeGreaterThan(0);
    expect(output.pools[0]).toMatchObject({ providerId: "claude-code", accounts: 2, available: 2, usedPercent: null, partial: true });
    const text = (await harness.behavior.runCli([])).stdout ?? "";
    expect(text.indexOf("Claude Code ∑")).toBeLessThan(text.indexOf("Claude Code · shared"));
    expect(usageCliSchema.safeParse({ providers: output.providers }).success).toBe(false);
  });
});

describe("server-only display setting", () => {
  it("defaults off and sends the server's stable ID alongside unfiltered collection", async () => {
    const { harness, getUsage, usageLimits } = await setupUsage();
    expect(harness.inspection.registrations.settingsDescriptors.serverOnly).toMatchObject({
      type: "boolean", label: "Only show providers on the server machine", default: false,
    });
    const snapshot = await getUsage();
    expect(snapshot).toMatchObject({ serverOnly: false, serverHostId: "server", serverHostError: null });
    expect(snapshot.providers.map(provider => provider.hostId)).toEqual(["remote", "server"]);
    expect(usageLimits).toHaveBeenCalledWith({ hostId: "remote" });
    expect(usageLimits).toHaveBeenCalledWith({ hostId: "server" });
  });

  it("updates all RPC readers without reloading or refetching cached provider quotas", async () => {
    const { harness, getUsage, usageLimits } = await setupUsage();
    const before = await getUsage();
    const signals = harness.inspection.realtimeSignals.length;
    await harness.behavior.setSettings({ serverOnly: true });
    await vi.waitFor(() => expect(harness.inspection.realtimeSignals).toHaveLength(signals + 1));
    expect(harness.inspection.realtimeSignals.at(-1)?.channel).toBe("usage-changed");
    for (let browser = 0; browser < 2; browser++) {
      const snapshot = await getUsage();
      expect(snapshot.serverOnly).toBe(true);
      expect(snapshot.providers).toEqual(before.providers);
      expect(snapshot.fetchedAt).toBe(before.fetchedAt);
    }
    expect(usageLimits).toHaveBeenCalledTimes(2);
    await harness.behavior.setSettings({ serverOnly: false });
    expect((await getUsage()).serverOnly).toBe(false);
  });

  it("persists the setting through a plugin reload", async () => {
    const { harness } = await setupUsage();
    await harness.behavior.setSettings({ serverOnly: true });
    const { harness: reloaded } = await harness.lifecycle.reload(plugin);
    cleanups.push(() => reloaded.lifecycle.dispose());
    expect(await reloaded.behavior.callRpc("getUsage", {})).toMatchObject({ serverOnly: true, serverHostId: "server" });
  });

  it("keeps CLI text/JSON and card settings independent of the display setting", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-12T12:00:00Z"));
    const { harness, config } = await setupUsage();
    const before = await harness.behavior.runCli(["--json"]);
    await harness.behavior.setSettings({ serverOnly: true });
    expect(await harness.behavior.runCli(["--json"])).toEqual(before);
    const text = await harness.behavior.runCli([]);
    expect(text.stdout).toContain("(Remote)");
    expect(text.stdout).toContain("(Server)");
    expect(config).not.toHaveBeenCalled();
    expect(await harness.behavior.callRpc("getCardSettings", {})).toEqual({ hiddenProviders: [] });
  });

  it.each([null, "missing"])("does not substitute a remote host when the server identity is %s", async primaryHostId => {
    const { scope, getUsage } = await setupUsage({ serverOnly: true });
    scope.primaryHostId = primaryHostId;
    const snapshot = await getUsage();
    expect(snapshot.serverHostId).toBe(primaryHostId);
    expect(snapshot.serverHostError).toContain("Server host");
    expect(snapshot.providers.map(provider => provider.hostId)).toContain("remote");
    const display = usageForDisplay({ data: snapshot, loading: false, error: null });
    expect(display.data?.accounts).toEqual([]);
    expect(display.data?.error).toBe(snapshot.serverHostError);
  });

  it("rechecks server availability against cached quota data", async () => {
    const { scope, getUsage, usageLimits } = await setupUsage({ serverOnly: true });
    const before = await getUsage();
    scope.hosts = scope.hosts.map(host => host.id === "server" ? { ...host, status: "disconnected" } : host);
    const snapshot = await getUsage();
    expect(snapshot).toMatchObject({
      providers: before.providers,
      serverHostId: "server",
      serverHostError: "Server host is offline. Reconnect it, then refresh usage.",
    });
    const display = usageForDisplay({ data: snapshot, loading: false, error: null });
    expect(display.data?.accounts).toEqual([]);
    expect(display.data?.error).toBe(snapshot.serverHostError);
    expect(usageLimits).toHaveBeenCalledTimes(2);
  });

  it.each(["remote", "server"])("isolates a %s host's collection failure from display scope", async failedHostId => {
    const { getUsage, usageLimits } = await setupUsage({ serverOnly: true });
    const result = await usageLimits({ hostId: "fixture" });
    usageLimits.mockImplementation(async ({ hostId }) => {
      if (hostId === failedHostId) throw new Error("read failed");
      return result;
    });
    const snapshot = await getUsage();
    expect(snapshot.error).toContain("read failed");
    expect(snapshot.serverHostError).toBeNull();
  });

  it.each(["error usage state", "thrown getResource", "failed listResources"])("keeps healthy server-only accounts visible after a provider failure (%s)", async failure => {
    const now = Date.parse("2026-10-12T12:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    let failing = failure !== "failed listResources";
    const sources = [
      { pluginId: "provider-codex", displayName: "Codex provider", providerId: "codex", label: "Codex Pro" },
      { pluginId: "provider-acp", displayName: "ACP provider", providerId: "opencode", label: "OpenCode" },
    ];
    const { bb, harness } = createFakePluginHost({
      pluginId: "usage-pace", settings: { grokUsage: false, serverOnly: true, showStrip: true },
      sdk: {
        hosts: { list: async () => [makeHostResponse({ id: "server", name: "Server", status: "connected" })] },
        providers: { list: async () => sources.map(source => ({ id: source.providerId, displayName: source.label })) },
        system: { config: async () => ({ primaryHostId: "server" }) },
        plugins: {
          experimental_discoverRpc: async () => sources,
          callRpc: async ({ pluginId, method }: { pluginId: string; method: string }) => {
            const source = sources.find(source => source.pluginId === pluginId)!;
            const failed = failing && pluginId === "provider-acp";
            if (method.endsWith("listResources")) {
              if (failed && failure === "failed listResources") throw new Error("usage unavailable");
              return { resources: [{
                id: `${source.providerId}-example.test`, providerId: source.providerId, label: source.label,
                accountKey: `${source.providerId}:example.test`, scope: { kind: "host", hostId: "server", hostName: "Server" },
              }] };
            }
            if (failed && failure === "thrown getResource") throw new Error("usage unavailable");
            const fields = { plan: null, accountEmail: `${source.providerId}@example.test`, planLabel: null };
            return { accountKey: `${source.providerId}:example.test`, observedAt: now, usage: failed
              ? { status: "error", ...fields, message: "usage unavailable" }
              : { status: "ok", ...fields, windows: [{ id: "weekly", kind: "weekly", label: "Weekly limit", usedPercent: 52, resetsAt: "2026-10-15T12:00:00Z" }] },
            };
          },
        },
      },
    });
    cleanups.push(() => harness.lifecycle.dispose());
    await plugin(bb);
    if (!failing) {
      const before = rpcContract.getUsage.output.parse(await harness.behavior.callRpc("getUsage", {}));
      expect(before.accounts).toHaveLength(2);
      failing = true;
    }
    const snapshot = rpcContract.getUsage.output.parse(await harness.behavior.callRpc("getUsage", { force: true }));
    const display = usageForDisplay({ data: snapshot, loading: false, error: null });
    expect(snapshot).toMatchObject({ serverOnly: true, showStrip: true, serverHostId: "server", serverHostError: null });
    expect(snapshot.error).toBe("ACP provider: usage unavailable");
    expect(display.data?.accounts).toHaveLength(2);
    expect(display.data?.accounts?.find(account => account.id === "codex")).toMatchObject({
      status: "ok", stale: false, message: null, windows: [expect.objectContaining({ weekly: true, usedPercent: 52 })],
    });
    expect(display.data?.accounts?.find(account => account.id === "opencode")).toMatchObject({
      status: failure === "failed listResources" ? "ok" : "error", stale: true, message: "ACP provider: usage unavailable",
    });
    expect(display.data?.error).toBeNull();
  });

  it("reports identity lookup failure without breaking collection or the CLI", async () => {
    const { getUsage, config, harness } = await setupUsage({ serverOnly: true });
    config.mockRejectedValue(new Error("config unavailable"));
    const snapshot = await getUsage();
    expect(snapshot).toMatchObject({ serverHostId: null, serverHostError: expect.stringContaining("Could not identify the server host") });
    expect(snapshot.providers).toHaveLength(2);
    expect((await harness.behavior.runCli([])).exitCode).toBe(0);
  });

  it("retains a host-list collection failure in the scoped unavailable state", async () => {
    const { getUsage, listHosts } = await setupUsage({ serverOnly: true });
    listHosts.mockRejectedValueOnce(new Error("could not list hosts"));
    expect(await getUsage()).toMatchObject({ serverHostId: "server", serverHostError: "could not list hosts", providers: [] });
  });
});
