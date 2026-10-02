// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UsageProvider } from "./server";
import { UsageBar } from "./app";
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
const render = async () => { await act(async () => root.render(<UsageBar onOpen={onOpen} />)); };

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  state = { data: { providers: [provider], fetchedAt: new Date(NOW).toISOString(), error: null }, loading: false, error: null };
  vi.spyOn(usageStore, "getUsageState").mockImplementation(() => state);
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
  // The footer portal is outside the overlay slot's automatic CSS scope.
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
  expect(container.textContent).toBe("C—W52%S32%");
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
