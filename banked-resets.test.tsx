// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageProvider } from "./server";
import type { BankedResets } from "./lib/banked-resets-contract";
import { BankedResetsBadge, BankedResetsList, BankedResetsSection } from "./banked-resets";
import { BankedResetsProvider, useRefreshBankedResets } from "./hooks/use-banked-resets";
import { UsageBar } from "./app";
import * as usageStore from "./lib/usage-store";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("@get-bb/plugin-sdk/app", () => ({
  // Deliberately unstable, as a real SDK client may be. Renders must not refetch.
  useRpc: () => ({ call: rpc }),
  useRealtime: () => {},
  definePluginApp: (factory: unknown) => factory,
  experimental_ProviderIcon: () => null,
  experimental_Icon: () => null,
}));

const NOW = Date.parse("2026-10-01T12:00:00Z");
const target = { hostId: "host-one", accountEmail: "one@example.test" };
const provider: UsageProvider = {
  ...target, id: "codex", displayName: "Codex", hostName: "One", status: "ok",
  logoUrl: null, icon: null, iconTint: null, message: null, planLabel: null,
  windows: [{ label: "Weekly", weekly: true, usedPercent: 52, resetsAt: "2026-10-03T12:00:00Z" }],
};
function inventory(count = 3, accountEmail = target.accountEmail): BankedResets {
  return { status: "ok", accountEmail, fetchedAt: new Date(NOW).toISOString(), availableCount: count, message: null,
    credits: [{ id: "credit", title: "Saved reset", supported: true, expiresAt: "2026-10-03T12:00:00Z" }] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function Refresh() {
  const refresh = useRefreshBankedResets();
  return <button data-refresh onClick={refresh}>Refresh</button>;
}

let root: Root;
let container: HTMLDivElement;
const render = async (element: ReactNode) => { await act(async () => { root.render(element); }); };
const click = async (element: HTMLElement) => { await act(async () => { element.click(); }); };
const badge = () => container.querySelector<HTMLButtonElement>('button[aria-label^="Codex:"]')!;
function surfaces(providers = [provider], active = true) {
  const selected = providers[0]!;
  return <BankedResetsProvider providers={providers} active={active}>
    <BankedResetsBadge target={selected} onOpen={() => {}} now={NOW} />
    <BankedResetsSection {...selected} />
    <Refresh />
  </BankedResetsProvider>;
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  rpc.mockReset().mockResolvedValue(inventory());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("shared footer/dialog inventory", () => {
  it("fetches once for both surfaces and refreshes both together", async () => {
    await render(surfaces());
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(badge().textContent).toBe("↺3");
    expect(badge().className).toContain("text-amber-600");
    expect(container.querySelector("section")?.textContent).toContain("3 banked");
    rpc.mockResolvedValue(inventory(2));
    await click(container.querySelector<HTMLButtonElement>("[data-refresh]")!);
    expect(rpc).toHaveBeenLastCalledWith("getBankedResets", { hostId: target.hostId, force: true });
    expect(badge().textContent).toBe("↺2");
    expect(container.querySelector("section")?.textContent).toContain("2 banked");
  });

  it("deduplicates accounts and never fetches banked resets for Claude", async () => {
    await render(surfaces([provider, { ...provider, hostId: "host-two" }, { ...provider, id: "claude-code" }]));
    expect(rpc).toHaveBeenCalledTimes(1);
    await render(surfaces([{ ...provider, id: "claude-code" }]));
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("treats a read failure as unknown, then recovers on focus", async () => {
    rpc.mockRejectedValueOnce(new Error("offline"));
    await render(surfaces());
    expect(badge().textContent).toBe("↺?");
    expect(badge().title).toContain("Could not refresh");
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(badge().textContent).toBe("↺3");
  });

  it("dims a confirmed zero without presenting an unavailable result as zero", async () => {
    rpc.mockResolvedValue({ ...inventory(0), credits: [] });
    await render(surfaces());
    expect(badge().textContent).toBe("↺0");
    expect(badge().className).toContain("opacity-50");
  });

  it("ignores a late response after the selected account changes", async () => {
    const first = deferred<BankedResets>();
    const second = deferred<BankedResets>();
    rpc.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await render(surfaces());
    expect(badge().textContent).toBe("↺…");
    const switched = { ...provider, accountEmail: "two@example.test" };
    await render(surfaces([switched]));
    await act(async () => first.resolve(inventory(9)));
    expect(badge().textContent).toBe("↺…");
    await act(async () => second.resolve(inventory(2, switched.accountEmail)));
    expect(badge().textContent).toBe("↺2");
  });

  it("does not attach another account's balance to the quota chip", async () => {
    rpc.mockResolvedValue(inventory(9, "different@example.test"));
    await render(surfaces());
    expect(badge().textContent).toBe("↺?");
    expect(badge().title).toContain("account changed");
  });

  it("pauses while hidden or disabled and disposes its polling", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await render(surfaces());
    await act(async () => { vi.advanceTimersByTime(5 * 60_000); });
    expect(rpc).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(rpc).toHaveBeenCalledTimes(1);
    await render(surfaces([provider], false));
    await act(async () => { vi.advanceTimersByTime(10 * 60_000); window.dispatchEvent(new Event("focus")); });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("polls every five minutes without retriggering from state renders", async () => {
    await render(surfaces());
    await act(async () => { vi.advanceTimersByTime(5 * 60_000); });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls.every(([method]) => method === "getBankedResets")).toBe(true);
  });

  it("queues an explicit forced refresh behind an in-flight read", async () => {
    const first = deferred<BankedResets>();
    rpc.mockReturnValueOnce(first.promise).mockResolvedValue(inventory(2));
    await render(surfaces());
    await click(container.querySelector<HTMLButtonElement>("[data-refresh]")!);
    expect(rpc).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve(inventory(3)));
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenLastCalledWith("getBankedResets", { hostId: target.hostId, force: true });
    expect(badge().textContent).toBe("↺2");
  });
});

it("scrolls and focuses the requested banked-reset section after overlay autofocus", async () => {
  await render(<BankedResetsList data={inventory()} loading={false} hostName="One" focusOnMount />);
  const section = container.querySelector("section")!;
  section.scrollIntoView = vi.fn();
  await act(async () => { vi.advanceTimersByTime(20); });
  expect(section.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  expect(document.activeElement).toBe(section);
});

it("adds only a Codex badge, keeps pace and Claude, and opens the selected account without nested buttons", async () => {
  const claude = { ...provider, id: "claude-code", displayName: "Claude" };
  const providers = [provider, claude];
  const state: usageStore.UsageState = {
    data: { providers, fetchedAt: new Date(NOW).toISOString(), error: null, showStrip: true }, error: null, loading: false,
  };
  vi.spyOn(usageStore, "getUsageState").mockReturnValue(state);
  const onOpen = vi.fn();
  await render(<BankedResetsProvider providers={providers} active>
    <UsageBar tokens={null} onOpen={onOpen} />
  </BankedResetsProvider>);
  expect(container.querySelectorAll('button[aria-label^="Codex:"]')).toHaveLength(1);
  expect(container.querySelector("button button")).toBeNull();
  expect(container.textContent).toContain("52%");
  expect(container.textContent).toContain("0.7×");
  expect(container.querySelector('button[aria-label="Claude usage. Open details."]')).not.toBeNull();
  await click(badge());
  expect(onOpen).toHaveBeenCalledWith(provider);
  expect(rpc.mock.calls.every(([method]) => method === "getBankedResets")).toBe(true);
});
