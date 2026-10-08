import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UsageProvider } from "./server";
import { ProviderBlock, UsageBar } from "./app";
import * as usageStore from "./lib/usage-store";

vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRealtime: () => {},
  definePluginApp: (factory: unknown) => factory,
  experimental_ProviderIcon: () => <span aria-hidden="true">C</span>,
  experimental_Icon: () => null,
}));

const NOW = Date.parse("2026-10-01T12:00:00Z");
const provider: UsageProvider = {
  id: "claude-code", displayName: "Claude Code", hostId: "one", hostName: "One",
  accountEmail: "one@example.test", status: "ok", message: null,
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
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  expect(vi.getTimerCount()).toBe(0);
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("renders a neutral W/S readout with a separately coloured pace glyph and accessible details", async () => {
  await render();
  const button = container.querySelector("button")!;
  expect(button.textContent).toBe("C●W52%S32%");
  expect(button.closest('[data-bb-plugin="usage-pace"]')).not.toBeNull();
  expect(button.getAttribute("aria-label")).toContain("Weekly limit: 52% used");
  expect(button.getAttribute("aria-label")).toContain("5-hour limit: 32% used");
  expect(button.title).toContain("All quota windows last to reset");
  expect(button.querySelectorAll("[style]")).toHaveLength(1);
  expect(button.querySelector(".col-start-3")?.textContent).toBe("W52%");
  expect(button.querySelector(".col-start-4")?.textContent).toBe("S32%");
  expect(button.getAttribute("aria-haspopup")).toBe("dialog");
  await act(async () => button.click());
  expect(onOpen).toHaveBeenCalledExactlyOnceWith();
});

it("shows an accessible run-out countdown below the compact quota values", async () => {
  state.data!.providers = [{ ...provider, windows: [{
    ...provider.windows[0]!, usedPercent: 11, resetsAt: "2026-10-08T07:00:00Z",
  }] }];
  await render();
  const button = container.querySelector("button")!;
  expect(button.textContent).toBe("C▲W11%out in 1d 16h");
  expect(button.title).toContain("Weekly limit: out in 1d 16h at the last reported pace");
  expect(button.getAttribute("aria-label")).toContain("out in 1d 16h");
  expect(button.querySelector(".row-start-2")?.textContent).toBe("out in 1d 16h");
  await act(async () => button.click());
  expect(onOpen).toHaveBeenCalledExactlyOnceWith();
});

it("ticks the footer countdown and removes it if refresh fails", async () => {
  state.data!.providers = [{ ...provider, windows: [{ ...provider.windows[1]!, usedPercent: 90 }] }];
  await render();
  expect(container.textContent).toContain("out in 20m");
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(container.textContent).toContain("out in 19m");
  state = { ...state, error: "Offline" };
  await render();
  expect(container.textContent).not.toContain("out in");
  expect(container.querySelector(".row-start-2")).toBeNull();
});

it("replaces all quota percentages with a single-line reset countdown when blocked", async () => {
  state.data!.providers = [{ ...provider, windows: [provider.windows[0]!, { ...provider.windows[1]!, usedPercent: 100 }] }];
  await render();
  const button = container.querySelector("button")!;
  const icon = button.querySelector('svg[data-icon="Hourglass"]');
  expect(icon).not.toBeNull();
  expect(icon?.parentElement?.style.color).toBe(usageStore.toneColor("warning"));
  expect(button.textContent).toBe("Cresets in 2h 0m");
  expect(button.querySelector(".row-start-2")).toBeNull();
  expect(button.querySelector(".row-start-1.col-span-2")?.textContent).toBe("resets in 2h 0m");
  expect(button.getAttribute("aria-label")).toContain("quota window is exhausted");
  expect(button.getAttribute("aria-label")).toContain("resets in 2h 0m");
  expect(button.title).toContain("Weekly limit: 52% used");
  expect(button.title).toContain("5-hour limit: 100% used");
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(container.querySelector(".row-start-1")?.textContent).toBe("resets in 1h 59m");
  expect(usageStore.refreshUsage).not.toHaveBeenCalled();
  await act(async () => button.click());
  expect(onOpen).toHaveBeenCalledExactlyOnceWith();
});

it("refreshes once when the reset countdown reaches zero and awaits confirmation even after failure", async () => {
  state.data!.providers = [{ ...provider, windows: [{
    ...provider.windows[1]!, usedPercent: 100, resetsAt: "2026-10-01T12:01:00Z",
  }] }];
  await render();
  expect(container.textContent).toContain("resets in 1m");
  expect(usageStore.refreshUsage).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(container.querySelector("button")?.textContent).toBe("Cawaiting refresh");
  expect(container.querySelector(".row-start-2")).toBeNull();
  expect(usageStore.refreshUsage).toHaveBeenCalledExactlyOnceWith({ force: true });
  state = { ...state, error: "Offline" };
  await render();
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(container.textContent).toContain("awaiting refresh");
  expect(container.querySelector("button")?.title).toContain("Offline");
  expect(usageStore.refreshUsage).toHaveBeenCalledTimes(1);

  state = { ...state, error: null, data: { ...state.data!, fetchedAt: new Date(Date.now()).toISOString(), providers: [provider] } };
  await render();
  expect(container.querySelector("button")?.textContent).toBe("C●W52%S32%");
  expect(container.querySelector('[data-icon="Hourglass"]')).toBeNull();
});

it("coalesces expired accounts into one refresh and waits for an existing request", async () => {
  const expired = { ...provider, windows: [{ ...provider.windows[1]!, usedPercent: 100, resetsAt: new Date(NOW).toISOString() }] };
  state = { ...state, loading: true, data: { ...state.data!, providers: [expired, { ...expired, accountEmail: "two@example.test" }] } };
  await render();
  expect(container.querySelectorAll(".row-start-1.col-span-2")).toHaveLength(2);
  expect(container.querySelector(".row-start-2")).toBeNull();
  expect(container.textContent).toContain("awaiting refresh");
  expect(usageStore.refreshUsage).not.toHaveBeenCalled();
  state = { ...state, loading: false };
  await render();
  expect(usageStore.refreshUsage).toHaveBeenCalledExactlyOnceWith({ force: true });
  state = { ...state, data: { ...state.data!, fetchedAt: new Date(NOW + 60_000).toISOString() } };
  await render();
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(usageStore.refreshUsage).toHaveBeenCalledTimes(1);

  state = { ...state, data: { ...state.data!, providers: [{ ...expired, windows: [{ ...expired.windows[0]!, resetsAt: "2026-10-01T12:02:00Z" }] }] } };
  await render();
  expect(container.textContent).toContain("resets in 1m");
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(usageStore.refreshUsage).toHaveBeenCalledTimes(2);
});

it("shows reset unknown without guessing or refreshing when an exhausted reset is missing", async () => {
  state.data!.providers = [{ ...provider, windows: [{ ...provider.windows[1]!, usedPercent: 100, resetsAt: null }] }];
  await render();
  expect(container.querySelector('[data-icon="Hourglass"]')).not.toBeNull();
  expect(container.querySelector("button")?.textContent).toBe("Creset unknown");
  expect(container.querySelector(".row-start-1")?.textContent).toBe("reset unknown");
  expect(container.querySelector(".row-start-2")).toBeNull();
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

it("keeps session-only values in the session column", async () => {
  state.data!.providers = [{ ...provider, windows: [provider.windows[1]!] }];
  await render();
  expect(container.querySelector(".col-start-3")).toBeNull();
  expect(container.querySelector(".col-start-4")?.textContent).toBe("S32%");
});

it("replaces reassuring status and window tooltips when refresh fails", async () => {
  await render();
  state = { ...state, error: "Offline" };
  await render();
  expect(container.querySelector("button")?.textContent).toBe("C—W52%S32%");
  expect(container.querySelector("button")?.title).toContain("stale or incomplete. Offline");
  expect(container.querySelector(".col-start-3")?.getAttribute("title")).toContain("stale or incomplete. Offline");
});

it("marks a passed reset unknown on the minute tick without another fetch", async () => {
  state.data!.providers = [{ ...provider, windows: [{ ...provider.windows[1]!, resetsAt: "2026-10-01T12:00:30Z" }] }];
  await render();
  expect(container.textContent).toContain("●");
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(container.textContent).toContain("—");
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

it("does not mistake a provider error for no limits", async () => {
  state.data!.providers = [{ ...provider, windows: [], status: "error" }];
  await render();
  expect(container.textContent).toBe("Usage unavailable");
});
