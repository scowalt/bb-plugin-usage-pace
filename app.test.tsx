import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UsageProvider } from "./server";
import { ProviderBlock, UsageBar, UsageOverlay } from "./app";
import * as usageStore from "./lib/usage-store";
import { BankedResetsProvider } from "./hooks/use-banked-resets";
import { mergeAccounts } from "./lib/usage-accounts";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRpc: () => ({ call: rpc }),
  useRealtime: () => {},
  definePluginApp: (factory: unknown) => factory,
  experimental_ProviderIcon: () => <span aria-hidden="true">C</span>,
  experimental_Icon: () => null,
}));

const NOW = Date.parse("2026-10-01T12:00:00Z");
const provider: UsageProvider = {
  id: "claude-code", displayName: "Claude Code", hostId: "one", hostName: "One",
  accountEmail: "one@example.test", status: "ok", message: null,
  accountKey: "one", accountLabel: "one", observedAt: NOW, plan: null, weight: null, stale: false,
  sources: [], hosts: [{ id: "one", name: "One" }],
  logoUrl: null, icon: null, iconTint: null, planLabel: null,
  windows: [
    { label: "Weekly limit", weekly: true, usedPercent: 52, resetsAt: "2026-10-03T12:00:00Z" },
    { label: "5-hour limit", weekly: false, usedPercent: 32, resetsAt: "2026-10-01T14:00:00Z" },
  ],
};
let root: Root;
let container: HTMLDivElement;
let state: usageStore.UsageState;
const onOpen = vi.fn();
const render = async (element = <UsageBar onOpen={onOpen} />) => { await act(async () => root.render(element)); };
const renderWeeklyWindow = (usedPercent: number, remainingHours = 163) => render(
  <ProviderBlock
    provider={{ ...provider, id: "codex", displayName: "Codex", windows: [{
      label: "Weekly limit", weekly: true, usedPercent,
      resetsAt: new Date(NOW + remainingHours * 3_600_000).toISOString(),
    }] }}
    showHost={false} showBankedResets={false} focusBankedResets={false}
  />,
);

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  state = { data: { providers: [provider], fetchedAt: new Date(NOW).toISOString(), error: null }, loading: false, error: null };
  vi.spyOn(usageStore, "getUsageState").mockImplementation(() => state);
  vi.spyOn(usageStore, "refreshUsage").mockResolvedValue();
  onOpen.mockReset();
  rpc.mockReset().mockResolvedValue({
    status: "ok", availableCount: 3, credits: [], accountEmail: provider.accountEmail, accountKey: provider.accountKey,
    fetchedAt: new Date(NOW).toISOString(), message: null,
  });
  usageStore.setOverlayOpen(false);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(vi.getTimerCount()).toBe(0);
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  usageStore.setOverlayOpen(false);
});

it("leads with weekly pace while retaining used quota and the saved reset balance", async () => {
  const codex = { ...provider, id: "codex", displayName: "Codex", windows: [{
    ...provider.windows[0]!, usedPercent: 11, resetsAt: new Date(NOW + 133.11451889 * 3_600_000).toISOString(),
  }] };
  state.data!.providers = [codex];
  rpc.mockResolvedValue({ status: "ok", availableCount: 2, credits: [], accountEmail: codex.accountEmail, accountKey: codex.accountKey,
    fetchedAt: new Date(NOW).toISOString(), message: null });
  await render(<BankedResetsProvider providers={[codex]} active><UsageBar onOpen={onOpen} /></BankedResetsProvider>);
  const button = container.querySelector<HTMLButtonElement>('button[aria-label*="Open usage details."]')!;
  expect(button.textContent).toContain("0.5× pace");
  expect(button.textContent).toContain("11% used");
  expect(button.textContent).not.toContain("●");
  expect(button.getAttribute("aria-label")).toContain("Weekly limit: 11% used");
  expect(button.getAttribute("aria-label")).toContain("1.0× is even pace");
  expect(container.querySelector('button[aria-label^="Codex:"]')?.textContent).toBe("↺2");
});

it.each([false, true])("does not call early-week usage near limit at 5% used (details and resets: %s)", async fullScenario => {
  const codex = { ...provider, id: "codex", displayName: "Codex", windows: [{
    ...provider.windows[0]!, usedPercent: 5,
    resetsAt: new Date(NOW + (168 - 168 * 5 / 95.1) * 3_600_000).toISOString(),
  }] };
  state.data!.providers = [codex];
  if (fullScenario) {
    rpc.mockResolvedValue({ status: "ok", availableCount: 2, credits: [], accountEmail: codex.accountEmail, accountKey: codex.accountKey,
      fetchedAt: new Date(NOW).toISOString(), message: null });
    await render(<>
      <BankedResetsProvider providers={[codex]} active><UsageBar onOpen={onOpen} /></BankedResetsProvider>
      <ProviderBlock provider={codex} showHost={false} showBankedResets={false} focusBankedResets={false} />
    </>);
    expect(container.textContent).toContain("on track for 95%");
    expect(container.querySelector('button[aria-label^="Codex:"]')?.textContent).toBe("↺2");
  } else {
    await render();
  }
  const button = container.querySelector<HTMLButtonElement>('button[aria-label*="Open usage details."]')!;
  expect(button.textContent).toContain("1.0× pace");
  expect(button.textContent).toContain("5% used");
  expect(button.textContent).not.toContain("near limit");
  expect(button.textContent).toContain("high projected use");
  expect(button.getAttribute("aria-label")).toContain("high projected use");
  expect(button.title).not.toContain("nearing a quota limit");
});

it("shows labelled weekly then session pace with accessible quota details", async () => {
  state.data!.providers = [{ ...provider, windows: [...provider.windows].reverse() }];
  await render();
  const button = container.querySelector("button")!;
  expect(button.textContent).toContain("W0.7× pace· 52% used");
  expect(button.textContent).toContain("S0.5× pace· 32% used");
  expect(button.textContent!.indexOf("W0.7×")).toBeLessThan(button.textContent!.indexOf("S0.5×"));
  expect(button.closest('[data-bb-plugin="usage-pace"]')).not.toBeNull();
  expect(button.getAttribute("aria-label")).toContain("Weekly limit: 52% used");
  expect(button.getAttribute("aria-label")).toContain("5-hour limit: 32% used");
  expect(button.title).toContain("All quota windows last to reset");
  expect(button.getAttribute("aria-haspopup")).toBe("dialog");
  await act(async () => button.click());
  expect(onOpen).toHaveBeenCalledExactlyOnceWith();
});

it.each([
  [0, 84, "0.0× pace", false],
  [20, 84, "0.4× pace", false],
  [50, 84, "1.0× pace", false],
  [50.05, 84, "1.0× pace", true],
  [80, 84, "1.6× pace", true],
  [11, 167.9, "185× pace", true],
])("formats %s%% weekly usage without rounding away the risk verdict", async (usedPercent, remainingHours, readout, runsOut) => {
  state.data!.providers = [{ ...provider, windows: [{ ...provider.windows[0]!, usedPercent,
    resetsAt: new Date(NOW + remainingHours * 3_600_000).toISOString() }] }];
  await render();
  const button = container.querySelector("button")!;
  expect(button.textContent).toContain(readout);
  expect(button.textContent).toContain(`${Math.round(usedPercent)}% used`);
  expect(button.textContent!.includes("short")).toBe(runsOut);
  if (runsOut) expect(button.title).toContain("runs out before reset");
});

it.each([
  ["Daily limit", "2026-10-02T00:00:00Z", "D0.4× pace"],
  ["Monthly credits", "2026-10-16T12:00:00Z", "M0.4× pace"],
  ["Credit balance", "2026-10-02T00:00:00Z", "Credit balanceunknown"],
  ["Weekly limit", null, "Wunknown"],
  ["Weekly limit", "invalid", "Wunknown"],
])("keeps fallback or unavailable pace attached to its quota window (%s)", async (label, resetsAt, readout) => {
  state.data!.providers = [{ ...provider, windows: [{ label, resetsAt, usedPercent: 20, weekly: label === "Weekly limit" }] }];
  await render();
  const button = container.querySelector("button")!;
  expect(button.textContent).toContain(readout);
  expect(button.textContent).toContain("20% used");
  expect(button.getAttribute("aria-label")).toContain(`${label}: 20% used`);
});

it("shows 4h short instead of a far-away run-out countdown", async () => {
  state.data!.providers = [{ ...provider, windows: [{
    ...provider.windows[0]!, usedPercent: 100 * 13 / 164,
    resetsAt: new Date(NOW + 155 * 3_600_000).toISOString(),
  }] }];
  await render();
  const button = container.querySelector("button")!;
  expect(button.textContent).toContain("4h short");
  expect(button.textContent).not.toContain("out in");
  expect(button.title).toContain("projected to run out 4h before reset");
  expect(button.title).toContain("out in 6d 7h");
  expect(button.getAttribute("aria-label")).toContain("projected to run out 4h before reset");
});

it("shows an accessible forecast shortfall below the compact quota values", async () => {
  state.data!.providers = [{ ...provider, windows: [{
    ...provider.windows[0]!, usedPercent: 11, resetsAt: "2026-10-08T07:00:00Z",
  }] }];
  await render();
  const button = container.querySelector("button")!;
  expect(button.textContent).toContain("W3.7× pace· 11% used");
  expect(button.textContent).toContain("5d 2h short");
  expect(button.title).toContain("Weekly limit: projected to run out 5d 2h before reset");
  expect(button.title).toContain("out in 1d 16h at the last reported pace");
  expect(button.getAttribute("aria-label")).toContain("projected to run out 5d 2h before reset");
  await act(async () => button.click());
  expect(onOpen).toHaveBeenCalledExactlyOnceWith();
});

it("keeps pace and shortfall snapshot-anchored and accepts a refreshed rate", async () => {
  state.data!.providers = [{ ...provider, windows: [{ ...provider.windows[1]!, usedPercent: 90 }] }];
  await render();
  expect(container.querySelector("button")?.textContent).toContain("1.5× pace");
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(container.querySelector("button")?.textContent).toContain("1.5× pace");
  expect(container.textContent).toContain("1h 40m short");
  expect(container.querySelector("button")?.title).toContain("out in 19m");
  state = { ...state, data: { ...state.data!, fetchedAt: new Date(Date.now()).toISOString(), providers: [{ ...provider, observedAt: Date.now(),
    windows: [{ ...provider.windows[1]!, usedPercent: 95 }] }] } };
  await render();
  expect(container.querySelector("button")?.textContent).toContain("1.6× pace");
  expect(container.querySelector("button")?.textContent).toContain("95% used");
  expect(container.querySelector("button")?.textContent).toContain("1h 49m short");
});

it("keeps an undisplayed model's projected exhaustion visible despite selected-window headroom", async () => {
  state.data!.providers = [{ ...provider, windows: [...provider.windows, {
    ...provider.windows[1]!, label: "Session model quota", usedPercent: 90,
  }] }];
  await render();
  const button = container.querySelector("button")!;
  expect(button.textContent).toContain("W0.7× pace");
  expect(button.textContent).toContain("S0.5× pace");
  expect(button.textContent).toContain("1h 40m short");
  expect(button.getAttribute("aria-label")).toContain("Session model quota: projected to run out 1h 40m before reset");
  expect(button.getAttribute("aria-label")).toContain("Session model quota: 90% used");
});

it("ticks the tooltip countdown without changing shortfall and removes it if refresh fails", async () => {
  state.data!.providers = [{ ...provider, windows: [{ ...provider.windows[1]!, usedPercent: 90 }] }];
  await render();
  expect(container.textContent).toContain("1h 40m short");
  expect(container.querySelector("button")?.title).toContain("out in 20m");
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(container.textContent).toContain("1h 40m short");
  expect(container.querySelector("button")?.title).toContain("out in 19m");
  state = { ...state, error: "Offline" };
  await render();
  expect(container.textContent).not.toContain("short");
  expect(container.querySelector("button")?.textContent).toContain("unknown");
});

it("replaces all quota percentages with a single-line reset countdown when blocked", async () => {
  state.data!.providers = [{ ...provider, windows: [provider.windows[0]!, { ...provider.windows[1]!, usedPercent: 100 }] }];
  await render();
  const button = container.querySelector("button")!;
  const icon = button.querySelector('svg[data-icon="Hourglass"]');
  expect(icon).not.toBeNull();
  expect(icon?.parentElement?.style.color).toBe(usageStore.toneColor("warning"));
  expect(button.textContent).toBe("Cresets in 2h 0m");
  expect(button.textContent).not.toContain("% used");
  expect(button.textContent).not.toContain("× pace");
  expect(button.getAttribute("aria-label")).toContain("quota window is exhausted");
  expect(button.getAttribute("aria-label")).toContain("resets in 2h 0m");
  expect(button.title).toContain("Weekly limit: 52% used");
  expect(button.title).toContain("5-hour limit: 100% used");
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(button.textContent).toBe("Cresets in 1h 59m");
  expect(usageStore.refreshUsage).not.toHaveBeenCalled();
  await act(async () => button.click());
  expect(onOpen).toHaveBeenCalledExactlyOnceWith();
});

it("refreshes once when the reset countdown reaches zero and awaits confirmation even after failure", async () => {
  state.data!.providers = [{ ...provider, windows: [{
    ...provider.windows[1]!, usedPercent: 100, resetsAt: "2026-10-01T12:01:00Z",
  }] }];
  state.data!.showStrip = true;
  vi.spyOn(usageStore, "getStripHost").mockReturnValue(container);
  await render(<UsageOverlay />);
  vi.mocked(usageStore.refreshUsage).mockClear();
  expect(container.textContent).toContain("resets in 1m");
  expect(usageStore.refreshUsage).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(container.querySelector("button")?.textContent).toBe("Cawaiting refresh");
  expect(container.textContent).not.toContain("% used");
  expect(usageStore.refreshUsage).toHaveBeenCalledExactlyOnceWith({ force: true });
  state = { ...state, error: "Offline" };
  await render(<UsageOverlay />);
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(container.textContent).toContain("awaiting refresh");
  expect(container.querySelector("button")?.title).toContain("Offline");
  expect(usageStore.refreshUsage).toHaveBeenCalledTimes(1);

  state = { ...state, error: null, data: { ...state.data!, fetchedAt: new Date(Date.now()).toISOString(), providers: [provider] } };
  await render(<UsageOverlay />);
  expect(container.querySelector("button")?.textContent).toContain("W0.7× pace· 52% used");
  expect(container.querySelector("button")?.textContent).toContain("S0.5× pace· 32% used");
  expect(container.querySelector('[data-icon="Hourglass"]')).toBeNull();
});

it("coalesces expired accounts into one refresh and waits for an existing request", async () => {
  const expired = { ...provider, windows: [{ ...provider.windows[1]!, usedPercent: 100, resetsAt: new Date(NOW).toISOString() }] };
  state = { ...state, loading: true, data: { ...state.data!, showStrip: true, providers: [expired, { ...expired, accountKey: "two", accountEmail: "two@example.test" }] } };
  vi.spyOn(usageStore, "getStripHost").mockReturnValue(container);
  await render(<UsageOverlay />);
  vi.mocked(usageStore.refreshUsage).mockClear();
  expect(container.querySelectorAll('button[aria-label*="Open usage details."]')).toHaveLength(2);
  expect(container.textContent).not.toContain("% used");
  expect(container.textContent).toContain("awaiting refresh");
  expect(usageStore.refreshUsage).not.toHaveBeenCalled();
  state = { ...state, loading: false };
  await render(<UsageOverlay />);
  expect(usageStore.refreshUsage).toHaveBeenCalledExactlyOnceWith({ force: true });
  state = { ...state, data: { ...state.data!, fetchedAt: new Date(NOW + 60_000).toISOString() } };
  await render(<UsageOverlay />);
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(usageStore.refreshUsage).toHaveBeenCalledTimes(1);

  state = { ...state, data: { ...state.data!, providers: [{ ...expired, windows: [{ ...expired.windows[0]!, resetsAt: "2026-10-01T12:02:00Z" }] }] } };
  await render(<UsageOverlay />);
  expect(container.textContent).toContain("resets in 1m");
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(usageStore.refreshUsage).toHaveBeenCalledTimes(2);
});

it("shows reset unknown without guessing or refreshing when an exhausted reset is missing", async () => {
  state.data!.providers = [{ ...provider, windows: [{ ...provider.windows[1]!, usedPercent: 100, resetsAt: null }] }];
  await render();
  expect(container.querySelector('[data-icon="Hourglass"]')).not.toBeNull();
  expect(container.querySelector("button")?.textContent).toBe("Creset unknown");
  expect(container.textContent).not.toContain("% used");
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(usageStore.refreshUsage).not.toHaveBeenCalled();
});

it("keeps passed run-out estimates distinct from confirmed exhaustion", async () => {
  state.data!.providers = [{ ...provider, windows: [{ ...provider.windows[1]!, usedPercent: 90 }] }];
  await render();
  await act(async () => { vi.advanceTimersByTime(21 * 60_000); });
  expect(container.textContent).toContain("▲");
  expect(container.textContent).toContain("out now (est.)");
  expect(container.querySelector('[data-icon="Hourglass"]')).toBeNull();
  expect(usageStore.refreshUsage).not.toHaveBeenCalled();
});

it("warns in the dialog about 11% used five hours into the week", async () => {
  await renderWeeklyWindow(11);
  expect(container.textContent).toContain("resets in 6d 19h");
  expect(container.textContent).toContain("3.7× pace · on track for over 300% · budget 13%/day");
  expect(container.textContent).toContain("5d 2h without quota");
  expect(container.textContent).toContain("runs out");
  expect(container.textContent).not.toContain("too early");
  expect(container.textContent).not.toContain("Lasts to reset");
});

it("does not reassure in the dialog when early pace is unknown", async () => {
  await renderWeeklyWindow(3);
  expect(container.textContent).toContain("too early to judge pace");
  expect(container.textContent).not.toContain("Lasts to reset");
  expect(container.textContent).not.toContain("without quota");
});

it("still shows Lasts to reset for a known sustainable pace", async () => {
  await renderWeeklyWindow(20, 84);
  expect(container.textContent).toContain("Lasts to reset");
});

it("shows only the reported session window without fabricating weekly usage", async () => {
  state.data!.providers = [{ ...provider, windows: [provider.windows[1]!] }];
  await render();
  expect(container.querySelector("button")?.textContent).toContain("S0.5× pace· 32% used");
  expect(container.querySelector("button")?.getAttribute("aria-label")).not.toContain("Weekly limit");
});

it("withdraws numeric pace and reassuring tooltips when refresh fails", async () => {
  await render();
  state = { ...state, error: "Offline" };
  await render();
  const button = container.querySelector("button")!;
  expect(button.textContent).toContain("Wunknown· usage unknown");
  expect(button.textContent).toContain("Sunknown· usage unknown");
  expect(button.textContent).not.toContain("× pace");
  expect(button.title).toContain("stale or incomplete. Offline");
  expect(button.title).not.toContain("0.7× pace");
  expect(button.querySelector("span[title]")?.title).toContain("stale or incomplete. Offline");
});

it("withdraws numeric pace and estimates for an incomplete snapshot", async () => {
  state = { ...state, data: { ...state.data!, error: "One host failed", providers: [{ ...provider, stale: true, message: "One host failed",
    windows: [{ ...provider.windows[1]!, usedPercent: 90 }] }] } };
  await render();
  const button = container.querySelector("button")!;
  expect(button.textContent).toContain("Sunknown· usage unknown");
  expect(button.textContent).not.toContain("× pace");
  expect(button.textContent).not.toContain("short");
  expect(button.getAttribute("aria-label")).toContain("One host failed");
});

it("keeps a hidden forecast warning distinct from current usage", async () => {
  state.data!.providers = [{ ...provider, windows: [...provider.windows, {
    label: "Weekly model limit", usedPercent: 5,
    resetsAt: new Date(NOW + (168 - 168 * 5 / 95.1) * 3_600_000).toISOString(),
  }] }];
  await render();
  const button = container.querySelector("button")!;
  expect(button.textContent).toContain("W0.7× pace");
  expect(button.textContent).toContain("S0.5× pace");
  expect(button.textContent).toContain("high projected use");
  expect(button.textContent).not.toContain("near limit");
  expect(button.getAttribute("aria-label")).toContain("Weekly model limit: 5% used");
});

it("keeps a hidden near-limit window visible even when the selected windows have headroom", async () => {
  state.data!.providers = [{ ...provider, windows: [...provider.windows, {
    label: "Weekly model limit", usedPercent: 96, resetsAt: "2026-10-01T13:00:00Z",
  }] }];
  await render();
  const button = container.querySelector("button")!;
  expect(button.textContent).toContain("W0.7× pace");
  expect(button.textContent).toContain("S0.5× pace");
  expect(button.textContent).toContain("near limit");
  expect(button.textContent).not.toContain("short");
  expect(button.getAttribute("aria-label")).toContain("Weekly model limit: 96% used");
  expect(button.textContent).not.toContain("●");
});

it.each([null, "invalid"])("warns about hidden reported usage near a limit even when its reset is unknown (%s)", async resetsAt => {
  state.data!.providers = [{ ...provider, windows: [...provider.windows, {
    label: "Weekly model limit", usedPercent: 96, resetsAt,
  }] }];
  await render();
  const button = container.querySelector("button")!;
  expect(button.textContent).toContain("W0.7× pace");
  expect(button.textContent).toContain("other pace unknown");
  expect(button.textContent).toContain("near limit");
  expect(button.textContent).not.toContain("short");
  expect(button.getAttribute("aria-label")).toContain("Weekly model limit: 96% used");
});

it.each([
  { label: "Model quota", usedPercent: 1, resetsAt: null },
  { label: "Weekly model limit", usedPercent: 1, resetsAt: "2026-10-08T11:00:00Z" },
])("shows hidden pace uncertainty alongside known selected windows ($label)", async hidden => {
  state.data!.providers = [{ ...provider, windows: [...provider.windows, hidden] }];
  await render();
  const button = container.querySelector("button")!;
  expect(button.textContent).toContain("W0.7× pace");
  expect(button.textContent).toContain("S0.5× pace");
  expect(button.textContent).toContain("other pace unknown");
  expect(button.title).not.toContain("All quota windows last");
  expect(button.getAttribute("aria-label")).toContain(`${hidden.label}: 1% used`);
});

it("distinguishes a too-early session from known weekly pace without claiming all windows are healthy", async () => {
  state.data!.providers = [{ ...provider, windows: [provider.windows[0]!, {
    ...provider.windows[1]!, usedPercent: 1, resetsAt: "2026-10-01T16:55:00Z",
  }] }];
  await render();
  const button = container.querySelector("button")!;
  expect(button.textContent).toContain("W0.7× pace· 52% used");
  expect(button.textContent).toContain("Stoo early· 1% used");
  expect(button.title).not.toContain("All quota windows last");
  expect(button.getAttribute("aria-label")).toContain("too early to judge pace");
  expect(button.textContent).not.toContain("short");
});

it("marks a passed reset unknown on the minute tick without another fetch", async () => {
  state.data!.providers = [{ ...provider, windows: [{ ...provider.windows[1]!, resetsAt: "2026-10-01T12:00:30Z" }] }];
  await render();
  expect(container.querySelector("button")?.textContent).toContain("0.3× pace");
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(container.querySelector("button")?.textContent).toContain("unknown");
  expect(container.querySelector("button")?.textContent).not.toContain("× pace");
  expect(container.querySelector("button")?.title).toContain("Reset passed");
});

it.each([
  [{ data: null, loading: true, error: null }, "Loading usage…"],
  [{ data: null, loading: false, error: "Offline" }, "Usage unavailable"],
  [{ data: null, loading: false, error: null }, "No usage limits"],
])("keeps the empty state clickable", async (empty, text) => {
  state = empty;
  await render();
  expect(container.textContent).toBe(text);
  await act(async () => container.querySelector("button")!.click());
  expect(onOpen).toHaveBeenCalledExactlyOnceWith();
});

it("never presents stale zero usage as available quota in the strip or dialog", async () => {
  const stale = { ...provider, stale: true, message: "Source offline", windows: [{ ...provider.windows[0]!, usedPercent: 0 }] };
  state.data!.providers = [stale];
  await render(<><UsageBar onOpen={onOpen} /><ProviderBlock provider={stale} showHost={false} showBankedResets={false} focusBankedResets={false} /></>);
  expect(container.textContent).toContain("usage unknown");
  expect(container.textContent).not.toContain("0%");
  expect(container.querySelector("button")?.title).not.toContain("0%");
});

it("does not mistake a provider error for no limits", async () => {
  state.data!.providers = [{ ...provider, windows: [], status: "error" }];
  await render();
  expect(container.textContent).toContain("usage unknown");
});

it("filters the strip before account deduplication so a remote duplicate cannot hide the server", async () => {
  state.data = {
    ...state.data!, serverOnly: true, serverHostId: provider.hostId, serverHostError: null,
    providers: [{ ...provider, hostId: "remote", hostName: "Laptop", hosts: [{ id: "remote", name: "Laptop" }] }, provider, { ...provider, hostId: "other", hosts: [{ id: "other", name: "Other" }], accountEmail: "remote@example.test" }],
  };
  await render();
  const rows = container.querySelectorAll<HTMLButtonElement>('button[aria-label*="Open usage details."]');
  expect(rows).toHaveLength(1);
  expect(rows[0]?.title).toContain("one@example.test · One");
  expect(rows[0]?.title).not.toContain("Laptop");
  expect(container.textContent).not.toContain("remote@example.test");
});

it("shows a server-specific clickable empty state when only remote hosts report usage", async () => {
  state.data = { ...state.data!, serverOnly: true, serverHostId: provider.hostId, providers: [{ ...provider, hostId: "remote", hosts: [{ id: "remote", name: "Remote" }] }] };
  await render();
  expect(container.textContent).toBe("No usage limits on server");
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(onOpen).toHaveBeenCalledExactlyOnceWith();
});

it.each([
  [null, "Server host is not available. Check bb's machine connection, then refresh."],
  ["one", "Server host is offline. Reconnect it, then refresh usage."],
])("shows server usage unavailable without a remote fallback (%s)", async (serverHostId, serverHostError) => {
  state.data = { ...state.data!, serverOnly: true, serverHostId, serverHostError, providers: [{ ...provider, hostId: "remote" }, provider] };
  await render();
  expect(container.textContent).toBe("Server usage unavailable");
  expect(container.querySelector("button")?.title).toBe(serverHostError);
  expect(container.querySelectorAll('button[aria-label*="Open usage details."]')).toHaveLength(0);
});

it("shows one row per issued account plus a pool without merging identical emails", async () => {
  const a = { ...provider, accountLabel: "A", weight: 20, plan: { id: "max", multiplier: 20 } };
  const b = { ...a, accountKey: "b", accountLabel: "B", weight: 5, plan: { id: "max", multiplier: 5 } };
  const c = { ...a, accountKey: "c", accountLabel: "C", weight: 1, plan: { id: "pro", multiplier: null }, windows: [{ ...provider.windows[1]!, usedPercent: 100 }] };
  state.data!.providers = [a, b, c, { ...a, hostId: "two", hosts: [{ id: "two", name: "Two" }] }];
  await render();
  expect(container.querySelectorAll('button[aria-label*="Open usage details."]')).toHaveLength(3);
  expect(container.querySelectorAll('button[aria-label*="Open pool details."]')).toHaveLength(1);
  expect(container.textContent).toContain("2/3 available");
  expect(container.textContent).toContain("(est.)");
  expect(container.textContent).not.toContain("0% used");
});

it("keeps shared accounts visible in the server-only view without reading a remote default login", async () => {
  const shared = { ...provider, accountKey: "shared", hostId: "", hosts: [], accountLabel: "Shared",
    sources: [{ pluginId: "claude-accounts", label: "Claude Accounts", resourceId: "shared", scope: { kind: "shared" as const } }] };
  state.data = { ...state.data!, showStrip: true, serverOnly: true, serverHostId: provider.hostId, serverHostError: "Server host is offline", providers: [shared] };
  const dialog = await renderOverlay();
  expect(container.textContent).toContain("0.7× pace");
  expect(dialog.textContent).toContain("Available on: shared · via Claude Accounts");
  expect(dialog.textContent).toContain("last read <1m ago");
  expect(rpc).not.toHaveBeenCalled();
});

async function renderOverlay() {
  vi.spyOn(usageStore, "getStripHost").mockReturnValue(container);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {
    day: 123, month: 456, timeZone: "UTC", fetchedAt: new Date(NOW).toISOString(), error: null,
  } }))));
  await act(async () => usageStore.setOverlayOpen(true));
  await render(<UsageOverlay />);
  return document.querySelector<HTMLElement>('[role="dialog"]')!;
}

it("updates the strip, dialog, and reset targets together when the display setting changes", async () => {
  const remote = { ...provider, hostId: "remote", hostName: "Laptop", hosts: [{ id: "remote", name: "Laptop" }], windows: [{ ...provider.windows[0]!, usedPercent: 80 }] };
  const remoteOnly = { ...remote, accountKey: "remote", hostId: "third", hostName: "Desktop", hosts: [{ id: "third", name: "Desktop" }], accountEmail: "remote@example.test" };
  state.data = { ...state.data!, showStrip: true, serverOnly: false, serverHostId: provider.hostId, serverHostError: null, providers: [remote, provider, remoteOnly] };
  const dialog = await renderOverlay();
  expect(container.querySelectorAll('button[aria-label*="Open usage details."]')).toHaveLength(2);
  expect(dialog.textContent).toContain("remote@example.test");
  expect(dialog.textContent).toContain("80%");
  expect(rpc).not.toHaveBeenCalledWith("getBankedResets", expect.objectContaining({ hostId: provider.hostId }));
  rpc.mockClear();

  state = { ...state, data: { ...state.data!, serverOnly: true } };
  await render(<UsageOverlay />);
  expect(container.querySelectorAll('button[aria-label*="Open usage details."]')).toHaveLength(1);
  expect(dialog.textContent).toContain("Server machine · Updated");
  expect(dialog.textContent).toContain("one@example.test");
  expect(dialog.textContent).toContain("52%");
  expect(dialog.textContent).not.toContain("remote@example.test");
  expect(dialog.textContent).not.toContain("80%");
  expect(dialog.querySelectorAll('section[aria-label="Claude limit resets"]')).toHaveLength(1);
  expect(rpc).toHaveBeenCalledExactlyOnceWith("getBankedResets", { hostId: provider.hostId, providerId: provider.id, force: false });
  expect(dialog.querySelector('[aria-label="Token usage across BB"]')?.textContent).toContain("Tokens · across BBToday123This month456");
  rpc.mockClear();

  state = { ...state, data: { ...state.data!, serverOnly: false } };
  await render(<UsageOverlay />);
  expect(container.querySelectorAll('button[aria-label*="Open usage details."]')).toHaveLength(2);
  expect(dialog.textContent).toContain("remote@example.test");
  expect(dialog.textContent).not.toContain("Server machine ·");
  expect(rpc).toHaveBeenCalledTimes(2);
  expect(rpc.mock.calls.map(([, input]) => input.hostId)).toEqual(["remote", "third"]);
});

it.each([
  [true, "One", "One"],
  [false, "One, Laptop", "One"],
  [false, "One, Laptop", "Laptop"],
] as const)("labels merged-account locations for the current view and the actual reset reader (server-only: %s)", async (serverOnly, location, resetHost) => {
  const local = { ...provider, observedAt: NOW - 2000, planLabel: "Max (20x)", sources: [
    { pluginId: "provider-claude-code", label: "Claude Code provider", resourceId: "one", scope: { kind: "host" as const, hostId: "one", hostName: "One" } },
  ] };
  const laptop = { ...local, hostId: "remote", hostName: "Laptop", observedAt: NOW, hosts: [{ id: "remote", name: "Laptop" }], sources: [
    { ...local.sources[0]!, resourceId: "remote", scope: { kind: "host" as const, hostId: "remote", hostName: "Laptop" } },
  ] };
  const shared = { ...local, hostId: "", hostName: "Claude Accounts", hosts: [], observedAt: NOW - 1000, sources: [
    { pluginId: "claude-accounts", label: "Claude Accounts", resourceId: "one", scope: { kind: "shared" as const } },
  ] };
  const accounts = [...mergeAccounts([local, laptop, shared]), { ...shared, accountKey: "pro", accountEmail: "pro@example.test", accountLabel: "pro", planLabel: "Pro" }];
  state.data = { ...state.data!, showStrip: true, serverOnly, serverHostId: "one", serverHostError: null, accounts, providers: accounts };
  rpc.mockImplementation(async (_method: string, input: { hostId: string }) => ({
    status: "ok", availableCount: 3, credits: [], accountEmail: "one@example.test", fetchedAt: new Date(NOW).toISOString(), message: null,
    accountKey: resetHost === "Laptop" && input.hostId === "one" ? "other" : "one",
  }));
  const dialog = await renderOverlay();
  const row = container.querySelector<HTMLButtonElement>('button[aria-label*="one@example.test"]')!;
  expect.soft(row.getAttribute("aria-label")?.split("\n")[0]).toBe(`Claude Code · one · one@example.test · ${location}`);
  expect.soft(dialog.textContent).toContain(`Max (20x) · one@example.test · ${location}`);
  expect.soft(dialog.textContent).toContain(`Available on: ${location} · via`);
  const resetSection = dialog.querySelector('section[aria-label="Claude limit resets"]');
  expect.soft(resetSection?.textContent).toContain(`one@example.test · ${resetHost} · Checked`);
  expect(rpc).toHaveBeenLastCalledWith("getBankedResets", { hostId: resetHost === "One" ? "one" : "remote", providerId: "claude-code", force: false });
});

it.each([
  ["Codex", "codex", "Codex"],
  ["Cursor", "Cursor", "Cursor"],
  ["opencode", "OPENCODE", "opencode"],
  ["Claude Code", "Work", "Claude Code · Work"],
])("avoids redundant account labels in strip and dialog headings (%s / %s)", async (displayName, accountLabel, heading) => {
  const account = { ...provider, displayName, accountLabel, accountEmail: null };
  state.data!.providers = [account, { ...account, accountKey: "other", accountLabel: "Personal" }];
  await render(<><UsageBar onOpen={onOpen} /><ProviderBlock provider={account} showHost showBankedResets={false} focusBankedResets={false} /></>);
  const row = container.querySelector<HTMLButtonElement>('button[aria-label*="Open usage details."]:not([aria-label*="Personal"])')!;
  expect.soft(row.getAttribute("aria-label")?.split("\n")[0]).toBe(`${heading} · One`);
  expect.soft(container.querySelector("span.text-sm.font-medium")?.textContent).toBe(heading);
  if (heading === displayName) expect.soft(row.textContent?.toLowerCase()).not.toContain(accountLabel.toLowerCase());
  else expect.soft(row.textContent).toContain(accountLabel);
});

it("honours the optional strip setting without reading saved resets while hidden", async () => {
  vi.spyOn(usageStore, "getStripHost").mockReturnValue(container);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {
    day: 0, month: 0, timeZone: "UTC", fetchedAt: new Date(NOW).toISOString(), error: null,
  } }))));
  state.data!.showStrip = false;
  await render(<UsageOverlay />);
  expect(container.querySelector('[aria-label="BB usage limits"]')).toBeNull();
  expect(rpc).not.toHaveBeenCalled();
  state = { ...state, data: { ...state.data!, showStrip: true } };
  await render(<UsageOverlay />);
  expect(container.querySelector('[aria-label="BB usage limits"]')).not.toBeNull();
  expect(container.textContent).toContain("0.7× pace");
  state = { ...state, data: { ...state.data!, showStrip: false } };
  await render(<UsageOverlay />);
  expect(container.querySelector('[aria-label="BB usage limits"]')).toBeNull();
});

it("does not read any resets or show another machine's details when the server is offline", async () => {
  const error = "Server host is offline. Reconnect it, then refresh usage.";
  state.data = { ...state.data!, showStrip: true, serverOnly: true, serverHostId: provider.hostId, serverHostError: error, providers: [provider, { ...provider, hostId: "remote" }] };
  const dialog = await renderOverlay();
  expect(container.textContent).toBe("Server usage unavailable");
  expect(dialog.textContent).toContain(error);
  expect(dialog.textContent?.split(error)).toHaveLength(2);
  expect(dialog.textContent).not.toContain("one@example.test");
  expect(dialog.querySelectorAll('section[aria-label="Claude limit resets"]')).toHaveLength(0);
  expect(rpc).not.toHaveBeenCalled();
});

it("explains in the dialog when the server has no reporting providers", async () => {
  state.data = { ...state.data!, showStrip: true, serverOnly: true, serverHostId: provider.hostId, providers: [{ ...provider, hostId: "remote", hosts: [{ id: "remote", name: "Remote" }] }] };
  const dialog = await renderOverlay();
  expect(dialog.textContent).toContain("No providers with usage reporting on the server.");
  expect(dialog.textContent).not.toContain("one@example.test");
  expect(rpc).not.toHaveBeenCalled();
});
