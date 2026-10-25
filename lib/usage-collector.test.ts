import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createFakePluginHost, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import { createUsageCollector, measurementSchema, sourceListSchema } from "./usage-collector";
import { makeAccount, NOW } from "../tests/usage-fixtures";
import { withAccountSettings } from "./usage-accounts";
import { usagePools } from "./usage-pools";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers(); });
const resource = (id: string, shared = true) => ({ id, accountKey: null, providerId: "claude-code", label: `${id}@example.test`,
  scope: shared ? { kind: "shared" } : { kind: "host", hostId: id, hostName: id },
});
function measurement(key = "a", observedAt = NOW) {
  const account = makeAccount();
  return { accountKey: `anthropic:account:${key}`, observedAt, usage: {
    status: "ok", plan: account.plan, accountEmail: `${key}@example.test`, planLabel: account.planLabel,
    windows: account.windows,
  } };
}
async function setup() {
  const sources = [{ pluginId: "machine", displayName: "Machine source" }, { pluginId: "pool", displayName: "Claude Accounts" }];
  const lists = new Map<string, unknown>([
    ["machine", { resources: [resource("beelink", false), resource("mac", false), resource("offline", false)] }],
    ["pool", { resources: [resource("a"), resource("b"), resource("c")] }],
  ]);
  const discover = vi.fn(async () => sources);
  const callRpc = vi.fn(async ({ pluginId, method, input }: { pluginId: string; method: string; input: { resourceId?: string; refresh?: boolean } }) => {
    if (method.endsWith("listResources")) return lists.get(pluginId);
    return measurement(pluginId === "machine" ? "a" : input.resourceId, pluginId === "pool" ? NOW + 1000 : NOW);
  });
  const { bb, harness } = createFakePluginHost({ pluginId: "usage-pace", sdk: {
    hosts: { list: async () => ["beelink", "mac", "offline"].map(id => makeHostResponse({ id, name: id, status: id === "offline" ? "disconnected" : "connected" })) },
    providers: { list: async () => [{ id: "claude-code", displayName: "Claude Code" }] },
    plugins: { experimental_discoverRpc: discover, callRpc: args => callRpc({ ...args, input: z.object({ resourceId: z.string().optional(), refresh: z.boolean().optional() }).parse(args.input) }) },
  } });
  cleanups.push(() => harness.lifecycle.dispose());
  let now = NOW;
  const controller = new AbortController();
  const collect = createUsageCollector(bb, controller.signal, () => now);
  return { collect, controller, discover, callRpc, lists, sources, advance: (ms: number) => { now += ms; } };
}

describe("discoverable usage collection", () => {
  it("probes a stuck weekly-only resource at most once per cache period and preserves its stale verdict between probes", async () => {
    const { collect, sources, lists, callRpc, advance } = await setup();
    sources.splice(0, 1);
    lists.set("pool", { resources: [resource("b")] });
    callRpc.mockImplementation(async args => args.method.endsWith("listResources") ? lists.get("pool") : {
      ...measurement("b", NOW - 29 * 3_600_000), usage: { ...measurement("b").usage, windows: [measurement("b").usage.windows[1]!] },
    });
    for (let poll = 0; poll < 3; poll++) {
      expect((await collect(false)).accounts[0]).toMatchObject({ stale: true, observedAt: NOW - 29 * 3_600_000,
        message: "Claude Accounts couldn't refresh this account. The source returned an old or unavailable reading.",
      });
    }
    const probes = () => callRpc.mock.calls.filter(([args]) => args.input.refresh);
    expect(probes()).toHaveLength(1);
    advance(299_999);
    expect((await collect(false)).accounts[0]?.stale).toBe(true);
    expect(probes()).toHaveLength(1);
    advance(1);
    expect((await collect(false)).accounts[0]?.stale).toBe(true);
    expect(probes()).toHaveLength(2);
    await collect(true);
    expect(probes()).toHaveLength(3);
  });

  it("keeps the freshness probe's reason visible on subsequent cached reads", async () => {
    const { collect, callRpc, sources, lists } = await setup();
    sources.splice(0, 1);
    lists.set("pool", { resources: [resource("b")] });
    callRpc.mockImplementation(async args => args.method.endsWith("listResources") ? lists.get("pool") : {
      ...measurement("b", NOW - 600_000), usage: { ...measurement("b").usage, message: args.input.refresh ? "Source login needs attention." : undefined },
    });
    await collect(false);
    expect((await collect(false)).accounts[0]?.message).toContain("Source login needs attention.");
  });

  it.each(["expired", "unauthenticated"])("does not let a known source's %s state displace healthy duplicates or leak windows into a changed identity", async status => {
    const { collect, callRpc, lists } = await setup();
    lists.set("pool", { resources: [resource("a"), resource("b")] });
    await collect(false);
    const original = callRpc.getMockImplementation()!;
    let accountKey: string | null = null;
    callRpc.mockImplementation(async args => args.pluginId === "machine" && args.input.resourceId === "mac" ? {
      accountKey, observedAt: null, usage: { status, accountEmail: null, plan: null, planLabel: null },
    } : original(args));
    const failed = await collect(true);
    expect(failed.accounts).toHaveLength(2);
    expect(failed.accounts.find(account => account.accountKey === "anthropic:account:a")).toMatchObject({
      status: "ok", stale: false, accountEmail: "a@example.test", message: `Machine source: ${status}`,
    });
    expect(failed.accounts.find(account => account.accountKey === "anthropic:account:a")?.sources).toHaveLength(3);
    accountKey = "anthropic:account:replacement";
    const changed = await collect(true);
    expect(changed.accounts.find(account => account.accountKey === accountKey)).toMatchObject({
      status, stale: true, windows: [], accountEmail: null, plan: null, planLabel: null,
    });
    expect(changed.accounts.find(account => account.accountKey === "anthropic:account:a")?.sources).toHaveLength(2);
  });

  it("collects three accounts once, merging default logins from two hosts with the pooled account", async () => {
    const { collect, callRpc } = await setup();
    const result = await collect(false);
    expect(result.accounts).toHaveLength(3);
    expect(result.accounts[0]).toMatchObject({ accountKey: "anthropic:account:a", observedAt: NOW + 1000 });
    expect(result.accounts[0]?.hosts.map(host => host.id)).toEqual(["beelink", "mac"]);
    expect(result.accounts[0]?.sources).toHaveLength(3);
    expect(callRpc.mock.calls.filter(([args]) => args.input.resourceId === "offline")).toHaveLength(0);
  });
  it("reads the provider, Account Pooler, and Claude Accounts contract fixtures", async () => {
    const raw = z.array(z.object({ source: z.string(), resource: z.unknown(), measurement: measurementSchema })).parse(JSON.parse(readFileSync(new URL("../tests/fixtures/usage-sources.json", import.meta.url), "utf8")));
    const fixtures = raw.map(fixture => ({ ...fixture, resource: sourceListSchema.parse({ resources: [fixture.resource] }).resources[0]! }));
    const { sources, collect, callRpc } = await setup();
    sources.splice(0, sources.length, ...fixtures.map(fixture => ({ pluginId: fixture.source, displayName: fixture.source })));
    callRpc.mockImplementation(async args => {
      const fixture = fixtures.find(fixture => fixture.source === args.pluginId)!;
      return args.method.endsWith("listResources") ? { resources: [fixture.resource] } : fixture.measurement;
    });
    const result = await collect(false);
    expect(result.error).toBeNull();
    expect(result.accounts.filter(account => account.id === "claude-code")).toHaveLength(3);
    expect(result.accounts.find(account => account.id === "codex")?.accountKey).toBe("openai:chatgpt:codex-account");
    expect(result.accounts.find(account => account.accountEmail === "a@example.test")?.windows[2]).toMatchObject({ kind: "weekly", model: "fable", weekly: true });
  });

  it("does not carry another account's windows across a login change that returns an error", async () => {
    const { sources, collect, callRpc, lists } = await setup();
    sources.splice(1);
    lists.set("machine", { resources: [resource("beelink", false)] });
    await collect(false);
    callRpc.mockImplementation(async args => args.method.endsWith("listResources") ? lists.get("machine") : {
      accountKey: "anthropic:account:replacement", observedAt: NOW,
      usage: { status: "error", plan: null, accountEmail: "replacement@example.test", planLabel: null, message: "usage unavailable" },
    });
    const result = await collect(true);
    expect(result.accounts[0]).toMatchObject({
      accountKey: "anthropic:account:replacement", observedAt: NOW, windows: [], stale: true,
      accountEmail: "replacement@example.test", plan: null, planLabel: null,
    });
  });

  it("keeps a known resource merged through keyless errors, recovery, and a later successful identity change", async () => {
    const { collect, callRpc, lists } = await setup();
    lists.set("pool", { resources: [resource("a"), resource("b")] });
    callRpc.mockImplementation(async args => args.method.endsWith("listResources") ? lists.get(args.pluginId)
      : measurement(args.pluginId === "machine" ? "a" : args.input.resourceId,
        NOW - (args.pluginId === "pool" ? 120_000 : args.input.resourceId === "beelink" ? 90_000 : 30_000)));
    const pool = (accounts: Awaited<ReturnType<typeof collect>>["accounts"]) => usagePools(
      accounts.map(account => withAccountSettings(account, new Map(), new Map())), new Date(NOW).toISOString(), NOW,
    )[0];
    const before = await collect(false);
    expect(before.accounts).toHaveLength(2);
    expect(pool(before.accounts)).toMatchObject({ accounts: 2, available: 2, unknown: 0, partial: false });
    expect(before.accounts.find(account => account.accountKey === "anthropic:account:a")).toMatchObject({ observedAt: NOW - 30_000 });
    const original = callRpc.getMockImplementation()!;
    callRpc.mockImplementation(async args => args.pluginId === "machine" && args.method.endsWith("getResource") && args.input.resourceId === "mac"
      ? { accountKey: null, observedAt: NOW - 30_000, usage: { status: "error", plan: null, accountEmail: null, planLabel: null, message: "fetch failed" } }
      : original(args));
    for (let refresh = 0; refresh < 2; refresh++) {
      const failed = await collect(true);
      expect(failed.accounts).toHaveLength(2);
      expect(pool(failed.accounts)).toMatchObject({ accounts: 2, available: 2, unknown: 0, usedPercent: 52, partial: false });
      const account = failed.accounts.find(account => account.accountKey === "anthropic:account:a")!;
      expect(account).toMatchObject({
        status: "ok", stale: false, observedAt: NOW - 90_000, accountEmail: "a@example.test",
        plan: { id: "max", multiplier: 20 }, planLabel: "Max 20x",
        hosts: expect.arrayContaining([{ id: "beelink", name: "beelink" }, { id: "mac", name: "mac" }]),
        message: "Machine source: fetch failed",
      });
      expect(withAccountSettings(account, new Map([["a@example.test", "Work"]]), new Map())).toMatchObject({ accountLabel: "Work", weight: 20 });
      expect(account.sources).toHaveLength(3);
      expect(failed.error).toBeNull();
    }
    callRpc.mockImplementation(original);
    expect(pool((await collect(true)).accounts)).toEqual(pool(before.accounts));
    callRpc.mockImplementation(async args => args.pluginId === "machine" && args.method.endsWith("getResource") && args.input.resourceId === "mac"
      ? measurement("replacement") : original(args));
    const changed = await collect(true);
    expect(changed.accounts).toHaveLength(3);
    expect(changed.accounts.find(account => account.accountKey === "anthropic:account:replacement")).toMatchObject({
      status: "ok", stale: false, hosts: [{ id: "mac", name: "mac" }],
    });
    expect(changed.accounts.find(account => account.accountKey === "anthropic:account:a")?.hosts).toEqual([{ id: "beelink", name: "beelink" }]);
  });

  it.each([null, "anthropic:account:a"])("keeps a sole source's account metadata and alias through errors with its last successful timestamp (%s key)", async accountKey => {
    const { collect, callRpc, lists } = await setup();
    lists.set("machine", { resources: [resource("beelink", false)] });
    lists.set("pool", { resources: [resource("b")] });
    callRpc.mockImplementation(async args => args.method.endsWith("listResources") ? lists.get(args.pluginId)
      : measurement(args.pluginId === "machine" ? "a" : "b", NOW - (args.pluginId === "machine" ? 30_000 : 120_000)));
    await collect(false);
    const original = callRpc.getMockImplementation()!;
    callRpc.mockImplementation(async args => args.pluginId === "machine" && args.method.endsWith("getResource")
      ? { accountKey, observedAt: NOW - 30_000, usage: { status: "error", plan: null, accountEmail: null, planLabel: null, message: "fetch failed" } }
      : original(args));
    for (let refresh = 0; refresh < 2; refresh++) {
      const result = await collect(true);
      expect(result.accounts).toHaveLength(2);
      const account = result.accounts.find(account => account.accountKey === "anthropic:account:a")!;
      expect(account).toMatchObject({
        stale: true, observedAt: NOW - 30_000, accountEmail: "a@example.test",
        plan: { id: "max", multiplier: 20 }, planLabel: "Max 20x", message: "Machine source: fetch failed",
      });
      expect(account.sources).toHaveLength(1);
      expect(account.windows).toHaveLength(3);
      expect(withAccountSettings(account, new Map([["a@example.test", "Work"]]), new Map())).toMatchObject({ accountLabel: "Work", weight: 20 });
      expect(usagePools(result.accounts.map(account => withAccountSettings(account, new Map(), new Map())),
        new Date(NOW).toISOString(), NOW)[0]).toMatchObject({ accounts: 2, available: 1, unknown: 1, partial: true });
      expect(result.error).toBeNull();
    }
  });

  it("uses supplied error metadata for the same identity while retaining omitted fields", async () => {
    const { collect, callRpc, sources, lists } = await setup();
    sources.splice(1);
    lists.set("machine", { resources: [resource("beelink", false)] });
    await collect(false);
    callRpc.mockImplementation(async args => args.method.endsWith("listResources") ? lists.get("machine") : {
      accountKey: null, observedAt: NOW,
      usage: { status: "error", accountEmail: null, plan: { id: "pro", multiplier: null }, planLabel: "Pro", message: "fetch failed" },
    });
    expect((await collect(true)).accounts[0]).toMatchObject({
      accountKey: "anthropic:account:a", stale: true, accountEmail: "a@example.test", plan: { id: "pro", multiplier: null }, planLabel: "Pro",
    });
  });

  it("never invents or merges identities for resources whose first reads are keyless errors", async () => {
    const { collect, callRpc, sources } = await setup();
    sources.splice(1);
    const original = callRpc.getMockImplementation()!;
    callRpc.mockImplementation(async args => args.method.endsWith("getResource")
      ? { accountKey: null, observedAt: null, usage: { status: "error", plan: null, accountEmail: "same@example.test", planLabel: null, message: "fetch failed" } }
      : original(args));
    for (let refresh = 0; refresh < 2; refresh++) {
      const result = await collect(true);
      expect(result.accounts).toHaveLength(2);
      expect(result.accounts.every(account => account.accountKey === null && account.stale && account.status === "error")).toBe(true);
    }
  });

  it("caches discovery for one minute and forwards force to every measurement", async () => {
    const { collect, discover, callRpc, advance } = await setup();
    await collect(false); await collect(true);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(callRpc.mock.calls.filter(([args]) => args.method.endsWith("getResource")).slice(-5).every(([args]) => args.input.refresh)).toBe(true);
    advance(60_000); await collect(false);
    expect(discover).toHaveBeenCalledTimes(2);
  });
  it("retains failed source rows with their timestamp and error, without making healthy accounts stale", async () => {
    const { collect, callRpc } = await setup();
    await collect(false);
    const original = callRpc.getMockImplementation()!;
    callRpc.mockImplementation(async args => {
      if (args.pluginId === "pool") throw new Error("pool offline");
      return original(args);
    });
    const result = await collect(true);
    expect(result.accounts).toHaveLength(3);
    expect(result.accounts.find(account => account.accountKey?.endsWith(":b"))).toMatchObject({ stale: true, observedAt: NOW + 1000, message: expect.stringContaining("pool offline") });
    expect(result.accounts.find(account => account.accountKey?.endsWith(":a"))).toMatchObject({ stale: false, message: expect.stringContaining("pool offline") });
    expect(result.error).toContain("pool offline");
  });
  it("never falls back to host-local usage when no sources exist or discovery fails", async () => {
    const { collect, discover } = await setup();
    discover.mockResolvedValue([]);
    expect((await collect(false)).accounts).toEqual([]);
  });
  it("retains measurements after a discovery failure and removes accounts removed by a successful inventory", async () => {
    const { collect, discover, lists, advance } = await setup();
    await collect(false); advance(60_000);
    discover.mockRejectedValueOnce(new Error("discovery offline"));
    expect((await collect(true)).accounts.every(account => account.stale)).toBe(true);
    lists.set("pool", { resources: [] });
    expect((await collect(true)).accounts).toHaveLength(1);
  });
  it("limits concurrent getResource calls to three", async () => {
    const { collect, callRpc, lists } = await setup();
    lists.set("pool", { resources: Array.from({ length: 9 }, (_, i) => resource(String(i))) });
    const original = callRpc.getMockImplementation()!;
    let active = 0, maximum = 0;
    callRpc.mockImplementation(async args => {
      if (!args.method.endsWith("getResource")) return original(args);
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--; return original(args);
    });
    await collect(false);
    expect(maximum).toBe(3);
  });
  it("times out uncooperative resource calls at five seconds instead of blocking the snapshot", async () => {
    vi.useFakeTimers();
    const { collect, callRpc, lists } = await setup();
    lists.set("pool", { resources: [resource("b")] });
    const original = callRpc.getMockImplementation()!;
    callRpc.mockImplementation(args => args.pluginId === "pool" && args.method.endsWith("getResource") ? new Promise(() => {}) : original(args));
    const pending = collect(false);
    await vi.advanceTimersByTimeAsync(5001);
    const result = await pending;
    expect(result.error).toBeNull();
    expect(result.accounts.find(account => account.status === "error")).toMatchObject({ windows: [], observedAt: null, stale: true, message: "Claude Accounts: Usage source timed out after 5 seconds." });
  });
});

it("accepts optional source group labels and null discovery identities", () => {
  expect(sourceListSchema.parse({ label: "Account Pooler", resources: [resource("a")] }).resources[0]?.accountKey).toBeNull();
});
