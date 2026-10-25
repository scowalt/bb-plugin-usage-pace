import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ExperimentalAppOverlayRegistration, ExperimentalSidebarFooterDisclosureRegistration, PluginAppBuilder, PluginContentScriptRegistration } from "@get-bb/plugin-sdk/app";
import type { UsageAccount } from "./server";

const sdk = vi.hoisted(() => ({ setup: null as ((app: PluginAppBuilder) => void) | null, rpc: vi.fn() }));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  definePluginApp: (setup: (app: PluginAppBuilder) => void) => { sdk.setup = setup; return { setup }; },
  useRealtime: () => {},
  useRpc: () => ({ call: sdk.rpc }),
  experimental_ProviderIcon: () => <span aria-hidden="true">C</span>,
  experimental_Icon: () => null,
}));

const NOW = Date.parse("2026-10-01T12:00:00Z");
const requests = vi.fn();
const open = vi.fn();
const close = vi.fn();
const toggle = vi.fn();
let disclosures: ExperimentalSidebarFooterDisclosureRegistration[];
let scripts: PluginContentScriptRegistration[];
let overlays: ExperimentalAppOverlayRegistration[];
let roots: Root[];
let cleanups: (() => void | Promise<void>)[];
let controller: AbortController;
let footer: HTMLDivElement;
let showStrip: boolean;
let accounts: UsageAccount[];
const account: UsageAccount = {
  id: "claude-code", displayName: "Claude Code", hostId: "test-host", hostName: "Test host", hosts: [{ id: "test-host", name: "Test host" }],
  accountKey: "synthetic-a", accountEmail: "a@example.test", accountLabel: "A", plan: null, planLabel: null, weight: null,
  status: "ok", message: null, stale: false, observedAt: NOW, sources: [], logoUrl: null, icon: null, iconTint: null,
  windows: [{ label: "5-hour limit", usedPercent: 100, resetsAt: new Date(NOW + 60_000).toISOString(), kind: "five-hour" }],
};
const usageRequests = () => requests.mock.calls.filter(([url]) => url.endsWith("/getUsage"));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  showStrip = true; accounts = [];
  disclosures = []; scripts = []; overlays = []; roots = []; cleanups = [];
  controller = new AbortController();
  open.mockClear(); close.mockClear(); toggle.mockClear(); sdk.rpc.mockReset().mockResolvedValue({
    status: "ok", availableCount: 2, credits: [], accountKey: account.accountKey, accountEmail: account.accountEmail,
    fetchedAt: new Date(NOW).toISOString(), message: null,
  });
  requests.mockReset().mockImplementation(async (url: string) => new Response(JSON.stringify(
    url.endsWith("/settings") ? { ok: true, values: { showStrip } }
      : url.endsWith("/getUsage") ? { ok: true, result: { accounts, providers: accounts, fetchedAt: new Date(Date.now()).toISOString(), error: null, showStrip } }
      : url.endsWith("/getTokens") ? { ok: true, result: { day: 0, month: 0, timeZone: "UTC", fetchedAt: new Date(NOW).toISOString(), error: null } }
      : { ok: true, result: { hiddenProviders: [] } },
  )));
  vi.stubGlobal("fetch", requests);
  footer = document.createElement("div");
  footer.dataset.sidebar = "footer";
  footer.innerHTML = '<button type="button">BB footer</button>';
  document.body.append(footer);
});

afterEach(async () => {
  await act(async () => {
    controller.abort();
    for (const cleanup of cleanups.reverse()) await cleanup();
    for (const root of [...roots].reverse()) root.unmount();
  });
  await act(async () => { await vi.runOnlyPendingTimersAsync(); });
  expect(vi.getTimerCount()).toBe(0);
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function start() {
  await import("./app");
  sdk.setup!({
    slots: { experimental_appOverlay: (item: ExperimentalAppOverlayRegistration) => overlays.push(item) },
    contentScripts: { register: (item: PluginContentScriptRegistration) => scripts.push(item) },
    experimental_sidebarFooter: { register: (item: ExperimentalSidebarFooterDisclosureRegistration) => { disclosures.push(item); return { open, close, toggle }; } },
  } as PluginAppBuilder);
  await act(async () => {
    for (const script of scripts) {
      const dispose = await script.mount({ pluginId: "usage-pace", generation: 1, signal: controller.signal, experimental_setThreadRowStatus: () => {} });
      if (dispose) cleanups.push(dispose);
    }
    for (const overlay of overlays) {
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      roots.push(root);
      root.render(<overlay.component />);
    }
  });
}

it("opens one sidebar footer disclosure at startup without injecting footer DOM", async () => {
  await start();
  expect.soft(disclosures).toHaveLength(1);
  expect.soft(disclosures[0]).toMatchObject({ kind: "disclosure", id: "usage-strip", label: "Usage Pace", icon: "ChartLine" });
  expect.soft(open).toHaveBeenCalledTimes(1);
  expect.soft(footer.innerHTML).toBe('<button type="button">BB footer</button>');
  expect.soft(document.getElementById("usage-pace-bar-host")).toBeNull();
});

it("registers no sidebar footer item with showStrip off", async () => {
  showStrip = false;
  await start();
  expect(disclosures).toHaveLength(0);
  expect(open).not.toHaveBeenCalled();
  requests.mockClear();
  await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
  expect(usageRequests()).toHaveLength(0);
});

it("keeps polling and focus/visibility refreshes while the disclosure is closed without reopening it", async () => {
  await start();
  expect(document.querySelector('[aria-label="BB usage limits"]')).toBeNull();
  requests.mockClear();
  await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
  expect(usageRequests()).toHaveLength(1);
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(usageRequests()).toHaveLength(2);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(5 * 60_000); });
  expect(usageRequests()).toHaveLength(2);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(usageRequests()).toHaveLength(3);
  expect(open).toHaveBeenCalledTimes(1);
});

it("refreshes once when a reset passes even while the disclosure is closed", async () => {
  accounts = [account];
  await start();
  requests.mockClear();
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(usageRequests()).toHaveLength(1);
  expect(JSON.parse(usageRequests()[0]![1].body)).toEqual({ force: true });
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(usageRequests()).toHaveLength(1);
  expect(sdk.rpc).not.toHaveBeenCalled();
  expect(open).toHaveBeenCalledTimes(1);
});

it("reads saved resets only while the actual disclosure or dialog is open", async () => {
  accounts = [{ ...account, windows: [{ ...account.windows[0]!, usedPercent: 20, resetsAt: new Date(NOW + 2 * 3_600_000).toISOString() }] }];
  await start();
  expect(sdk.rpc).not.toHaveBeenCalled();
  const host = document.createElement("div");
  document.body.append(host);
  const stripRoot = createRoot(host);
  roots.push(stripRoot);
  const Component = disclosures[0]!.component;
  await act(async () => { stripRoot.render(<Component dismiss={() => {}} />); });
  expect(sdk.rpc).toHaveBeenCalledExactlyOnceWith("getBankedResets", { hostId: "test-host", providerId: "claude-code", force: false });
  expect(host.querySelector('[aria-label="BB usage limits"]')).not.toBeNull();
  expect(host.textContent).toContain("↺2");
  sdk.rpc.mockClear();
  await act(async () => { stripRoot.render(null); });
  await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
  expect(sdk.rpc).not.toHaveBeenCalled();
  const store = await import("./lib/usage-store");
  await act(async () => { store.setOverlayOpen(true); });
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(sdk.rpc).toHaveBeenCalledTimes(1);
  sdk.rpc.mockClear();
  await act(async () => { store.setOverlayOpen(false); });
  await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
  expect(sdk.rpc).not.toHaveBeenCalled();
  await act(async () => { stripRoot.render(<Component dismiss={() => {}} />); });
  expect(sdk.rpc).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledTimes(1);
});
