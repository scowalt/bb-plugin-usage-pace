import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import plugin, { rpcContract } from "./server";
import { ProviderBlock, UsageBar } from "./app";
import * as usageStore from "./lib/usage-store";
import { usageCliSchema } from "./lib/usage-cli";
import { measurementSchema } from "./lib/usage-collector";

vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRpc: () => ({ call: vi.fn() }),
  useRealtime: () => {},
  definePluginApp: (factory: unknown) => factory,
  experimental_ProviderIcon: () => <span aria-hidden="true">C</span>,
  experimental_Icon: () => null,
}));

const LAST_READ = Date.parse("2026-10-23T22:11:31Z");
const AFTER_RESET = Date.parse("2026-10-25T03:15:00Z");
const BEFORE_RESET = Date.parse("2026-10-23T22:26:31Z");
const oldWindows = [
  { id: "session", label: "Current session", kind: "five-hour", usedPercent: 36, resetsAt: "2026-10-24T00:50:00Z" },
  { id: "weekly", label: "Weekly limit", kind: "weekly", usedPercent: 11, resetsAt: "2026-10-30T10:00:00Z" },
];
const cleanups: (() => Promise<void>)[] = [];
let root: Root;
let container: HTMLDivElement;
let state: usageStore.UsageState;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  vi.setSystemTime(AFTER_RESET);
  state = { data: null, loading: false, error: null };
  vi.spyOn(usageStore, "getUsageState").mockImplementation(() => state);
  vi.spyOn(usageStore, "refreshUsage").mockResolvedValue();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  for (const cleanup of cleanups.splice(0)) await cleanup();
  expect(vi.getTimerCount()).toBe(0);
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function setup(cacheMinutes = 5) {
  const callRpc = vi.fn(async ({ method, input }: { method: string; input: { resourceId?: string; refresh?: boolean } }): Promise<unknown> => {
    if (method.endsWith("listResources")) return { resources: ["a", "b"].map(id => ({
      id, providerId: "claude-code", label: `${id}@example.test`, accountKey: `anthropic:account:${id}`, scope: { kind: "shared" },
    })) };
    const isB = input.resourceId === "b";
    return { accountKey: `anthropic:account:${input.resourceId}`, observedAt: isB ? LAST_READ : Date.now(), usage: {
      status: "ok", accountEmail: `${input.resourceId}@example.test`,
      plan: isB ? { id: "pro", multiplier: 1 } : { id: "max", multiplier: 20 }, planLabel: isB ? "Pro" : "Max 20x",
      windows: isB ? oldWindows : oldWindows.map((window, index) => ({ ...window, usedPercent: index === 0 ? 7 : 40,
        resetsAt: new Date(Date.now() + (index === 0 ? 2 : 126) * 3_600_000).toISOString() })),
    } };
  });
  const { bb, harness } = createFakePluginHost({
    pluginId: "usage-pace", settings: { grokUsage: false, serverOnly: true, cacheMinutes },
    sdk: {
      hosts: { list: async () => [makeHostResponse({ id: "server", name: "Server", status: "connected" })] },
      providers: { list: async () => [{ id: "claude-code", displayName: "Claude Code" }] },
      system: { config: async () => ({ primaryHostId: "server" }) },
      plugins: { experimental_discoverRpc: async () => [{ pluginId: "claude-accounts", displayName: "Claude Accounts" }], callRpc },
    },
  });
  cleanups.push(() => harness.lifecycle.dispose());
  await plugin(bb);
  const getUsage = async (force: boolean) => rpcContract.getUsage.output.parse(await harness.behavior.callRpc("getUsage", { force }));
  return { harness, getUsage, callRpc };
}

describe("cached last-success readings", () => {
  it("refreshes a healthy on-demand resource's old cache without making the account stale", async () => {
    vi.setSystemTime(BEFORE_RESET);
    const { getUsage, callRpc } = await setup();
    const original = callRpc.getMockImplementation()!;
    callRpc.mockImplementation(async args => {
      const value = await original(args);
      return args.method.endsWith("getResource") && args.input.resourceId === "a" && !args.input.refresh
        ? { ...measurementSchema.parse(value), observedAt: LAST_READ } : value;
    });
    const snapshot = await getUsage(false);
    expect(snapshot.accounts!.find(account => account.accountKey === "anthropic:account:a")).toMatchObject({ stale: false, observedAt: BEFORE_RESET, message: null });
    expect(callRpc.mock.calls.filter(([args]) => args.input.resourceId === "a").map(([args]) => args.input.refresh)).toEqual([false, true]);
    expect(snapshot.pools![0]).toMatchObject({ available: 1, unknown: 1 });
  });

  it("uses the configured cache period without mistaking a permitted cached response for failure", async () => {
    vi.setSystemTime(BEFORE_RESET);
    const { getUsage, callRpc, harness } = await setup(20);
    expect((await getUsage(false)).accounts!.find(account => account.accountKey === "anthropic:account:b")).toMatchObject({ stale: false });
    expect(callRpc.mock.calls.filter(([args]) => args.input.refresh)).toHaveLength(0);
    await harness.behavior.setSettings({ cacheMinutes: 0.5 });
    vi.setSystemTime(BEFORE_RESET + 31_000);
    expect((await getUsage(false)).accounts!.find(account => account.accountKey === "anthropic:account:b")).toMatchObject({ stale: true });
    expect(callRpc.mock.calls.filter(([args]) => args.input.refresh).map(([args]) => args.input.resourceId)).toEqual(["b"]);
  });

  it("retains the cached reading if the per-resource freshness probe rejects", async () => {
    const { getUsage, callRpc } = await setup();
    const original = callRpc.getMockImplementation()!;
    callRpc.mockImplementation(async args => {
      if (args.input.resourceId === "b" && args.input.refresh) throw new Error("The access token has expired; sign in on the source host.");
      return original(args);
    });
    const snapshot = await getUsage(false);
    expect(snapshot.accounts!.find(account => account.accountKey === "anthropic:account:b")).toMatchObject({
      observedAt: LAST_READ, stale: true, windows: oldWindows.map(window => ({ ...window, weekly: window.kind === "weekly" })),
      message: "Claude Accounts: The access token has expired; sign in on the source host.",
    });
    expect(snapshot.pools![0]).toMatchObject({ accounts: 2, available: 1, unknown: 1 });
    expect(snapshot.error).toBeNull();
  });

  it.each(["error", "expired", "unauthenticated"])("retains the just-read cached windows when the freshness probe reports %s", async status => {
    const { getUsage, callRpc } = await setup();
    const original = callRpc.getMockImplementation()!;
    callRpc.mockImplementation(async args => args.input.resourceId === "b" && args.input.refresh ? {
      accountKey: null, observedAt: null, usage: { status, plan: null, accountEmail: null, planLabel: null, message: "Source login needs attention." },
    } : original(args));
    const snapshot = await getUsage(false);
    expect(snapshot.accounts!.find(account => account.accountKey === "anthropic:account:b")).toMatchObject({
      stale: true, observedAt: LAST_READ, accountEmail: "b@example.test", windows: oldWindows.map(window => ({ ...window, weekly: window.kind === "weekly" })),
      message: expect.stringContaining("Source login needs attention."),
    });
  });

  it.each(["expired", "unauthenticated"])("retains a known account's last successful windows and reason through %s", async status => {
    vi.setSystemTime(LAST_READ);
    const { harness, getUsage, callRpc } = await setup();
    await getUsage(false);
    const original = callRpc.getMockImplementation()!;
    callRpc.mockImplementation(async args => args.method.endsWith("getResource") && args.input.resourceId === "b" ? {
      accountKey: null, observedAt: null, usage: { status, plan: null, accountEmail: null, planLabel: null, message: "Sign in on the source host." },
    } : original(args));
    vi.setSystemTime(AFTER_RESET);
    for (let attempt = 0; attempt < 2; attempt++) {
      const snapshot = await getUsage(true);
      const b = snapshot.accounts!.find(account => account.accountKey === "anthropic:account:b")!;
      expect(b).toMatchObject({ status, stale: true, observedAt: LAST_READ, accountEmail: "b@example.test", planLabel: "Pro",
        message: `Claude Accounts: ${status} — Sign in on the source host.`, windows: oldWindows.map(window => ({ ...window, weekly: window.kind === "weekly" })),
      });
      expect(snapshot.pools![0]).toMatchObject({ accounts: 2, available: 1, unknown: 1 });
      state.data = snapshot;
      await act(async () => root.render(<><UsageBar onOpen={() => {}} /><ProviderBlock provider={b} showHost showBankedResets={false} focusBankedResets={false} /></>));
      expect(container.querySelector<HTMLButtonElement>('button[title*="b@example.test"]')?.title).toContain(`Claude Accounts: ${status}`);
      expect(container.textContent).toContain("last read 29h ago");
      expect(container.textContent).not.toMatch(/36%|11%/u);
      expect((await harness.behavior.runCli(["--all"])).stdout).toContain("last read 29h ago");
    }
  });

  it.each([false, true])("B after a reset passed: shows last read 29h ago without retry advice after refresh (force: %s)", async force => {
    const { harness, getUsage } = await setup();
    const snapshot = await getUsage(force);
    const account = snapshot.accounts!.find(account => account.accountKey === "anthropic:account:b")!;
    expect.soft(account).toMatchObject({ stale: true, observedAt: LAST_READ });
    expect.soft(snapshot.pools[0]).toMatchObject({ accounts: 2, available: 1, unknown: 1, partial: true });
    const text = (await harness.behavior.runCli(["--all", "--force"])).stdout ?? "";
    expect.soft(text).toContain("last read 29h ago");
    expect.soft(text).toContain("Claude Accounts couldn't refresh this account");
    expect.soft(text).not.toMatch(/refresh usage|refresh to check/iu);
    state.data = await getUsage(false);
    const b = state.data.accounts!.find(account => account.accountKey === "anthropic:account:b")!;
    await act(async () => root.render(<><UsageBar onOpen={() => {}} /><ProviderBlock provider={b} showHost showBankedResets={false} focusBankedResets={false} /></>));
    const button = container.querySelector<HTMLButtonElement>('button[title*="b@example.test"]')!;
    expect.soft(button.title).toContain("last read 29h ago");
    expect.soft(button.title).toContain("Claude Accounts couldn't refresh this account");
    expect.soft(button.title).not.toMatch(/refresh usage|refresh to check/iu);
    expect.soft(container.textContent).toContain("last read 29h ago");
    expect.soft(container.textContent).toContain("Claude Accounts couldn't refresh this account");
    expect.soft(container.textContent).not.toMatch(/refresh to check|36%|11%|Lasts to reset/iu);
    expect.soft(button.textContent).toContain("usage unknown");
    expect.soft(button.textContent).not.toContain("× pace");
    const json = usageCliSchema.parse(JSON.parse((await harness.behavior.runCli(["--json"])).stdout ?? ""));
    expect.soft(json.accounts.find(account => account.accountKey === b.accountKey)?.windows.map(window => window.pace)).toEqual([null, null]);
  });

  it.each([false, true])("B before any reset passed: old reading is unknown, not current pace (force: %s)", async force => {
    vi.setSystemTime(BEFORE_RESET);
    const { harness, getUsage } = await setup();
    const snapshot = await getUsage(force);
    const account = snapshot.accounts!.find(account => account.accountKey === "anthropic:account:b")!;
    expect.soft(account).toMatchObject({ stale: true, observedAt: LAST_READ });
    expect.soft(snapshot.pools[0]).toMatchObject({ accounts: 2, available: 1, unknown: 1, partial: true });
    const text = (await harness.behavior.runCli(["--all", "--force"])).stdout ?? "";
    expect.soft(text).toContain("last read 15m ago");
    expect.soft(text).toContain("Claude Accounts couldn't refresh this account");
    expect.soft(text).not.toMatch(/refresh usage|refresh to check/iu);
    state.data = await getUsage(false);
    const b = state.data.accounts!.find(account => account.accountKey === "anthropic:account:b")!;
    await act(async () => root.render(<><UsageBar onOpen={() => {}} /><ProviderBlock provider={b} showHost showBankedResets={false} focusBankedResets={false} /></>));
    const button = container.querySelector<HTMLButtonElement>('button[title*="b@example.test"]')!;
    expect.soft(button.title).toContain("last read 15m ago");
    expect.soft(button.title).toContain("Claude Accounts couldn't refresh this account");
    expect.soft(button.title).not.toMatch(/refresh usage|refresh to check/iu);
    expect.soft(button.textContent).toContain("usage unknown");
    expect.soft(button.textContent).not.toContain("× pace");
    expect.soft(container.textContent).toContain("last read 15m ago");
    expect.soft(container.textContent).not.toMatch(/refresh to check|36%|11%|Lasts to reset/iu);
  });
});
