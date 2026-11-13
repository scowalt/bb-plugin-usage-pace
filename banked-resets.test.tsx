import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageProvider } from "./server";
import type { BankedResets } from "./lib/banked-resets-contract";
import { BankedResetsBadge, BankedResetsList, BankedResetsSection } from "./banked-resets";
import { BankedResetsProvider, bankedResetSectionId, useRefreshBankedResets } from "./hooks/use-banked-resets";
import { UsageBar } from "./app";
import * as usageStore from "./lib/usage-store";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRpc: () => ({ call: rpc }),
  useRealtime: () => {},
  definePluginApp: (factory: unknown) => factory,
  experimental_ProviderIcon: () => null,
  experimental_Icon: () => null,
}));

const NOW = Date.parse("2026-10-01T12:00:00Z");
const target = { hostId: "host-one", accountEmail: "one@example.test", accountKey: "one" };
const provider: UsageProvider = {
  ...target, id: "codex", displayName: "Codex", hostName: "One", status: "ok",
  accountLabel: "one", observedAt: NOW, plan: null, weight: null, stale: false,
  sources: [], hosts: [{ id: "host-one", name: "One" }],
  logoUrl: null, icon: null, iconTint: null, message: null, planLabel: null,
  windows: [{ label: "Weekly", weekly: true, usedPercent: 52, resetsAt: "2026-10-03T12:00:00Z" }],
};
function inventory(count = 3, accountEmail = target.accountEmail): BankedResets {
  return { status: "ok", accountEmail, accountKey: accountEmail === target.accountEmail ? "one" : "other", fetchedAt: new Date(NOW).toISOString(), availableCount: count, message: null,
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
    expect(rpc).toHaveBeenLastCalledWith("getBankedResets", { hostId: target.hostId, providerId: "codex", force: true });
    expect(badge().textContent).toBe("↺2");
    expect(container.querySelector("section")?.textContent).toContain("2 banked");
  });

  it("deduplicates accounts within a provider, never across Claude and Codex", async () => {
    const claude = { ...provider, id: "claude-code" };
    await render(surfaces([provider, { ...provider, hostId: "host-two" }, claude, { ...claude, hostId: "host-two" }, { ...provider, id: "other" }]));
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith("getBankedResets", { hostId: target.hostId, providerId: "codex", force: false });
    expect(rpc).toHaveBeenCalledWith("getBankedResets", { hostId: target.hostId, providerId: "claude-code", force: false });
  });

  it("treats a read failure as unknown, then recovers on focus", async () => {
    rpc.mockRejectedValueOnce(new Error("offline"));
    await render(surfaces());
    expect(badge()).toBeNull();
    expect(container.querySelector("section")).toBeNull();
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
    expect(badge()).toBeNull();
    const switched = { ...provider, accountKey: "other", accountEmail: "two@example.test" };
    await render(surfaces([switched]));
    await act(async () => first.resolve(inventory(9)));
    expect(badge()).toBeNull();
    await act(async () => second.resolve(inventory(2, switched.accountEmail)));
    expect(badge().textContent).toBe("↺2");
  });

  it("does not attach another account's balance to the quota chip", async () => {
    rpc.mockResolvedValue(inventory(9, "different@example.test"));
    await render(surfaces());
    expect(badge()).toBeNull();
  });

  it("uses provider-issued identity rather than email for accounts sharing a host", async () => {
    const other = { ...provider, accountKey: "other" };
    await render(<BankedResetsProvider providers={[provider, other]} active>
      <div data-account="one"><BankedResetsBadge target={provider} onOpen={() => {}} /></div>
      <div data-account="other"><BankedResetsBadge target={other} onOpen={() => {}} /></div>
    </BankedResetsProvider>);
    expect(container.querySelector('[data-account="one"] button')?.textContent).toBe("↺3");
    expect(container.querySelector('[data-account="other"] button')).toBeNull();
  });

  it("keeps a verified failed inventory read unknown, not zero", async () => {
    rpc.mockResolvedValue({ ...inventory(), status: "error", availableCount: null, credits: [], message: "Inventory read failed" });
    await render(surfaces());
    expect(badge().textContent).toBe("↺?");
    expect(badge().title).toContain("Inventory read failed");
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
    expect(rpc).toHaveBeenLastCalledWith("getBankedResets", { hostId: target.hostId, providerId: "codex", force: true });
    expect(badge().textContent).toBe("↺2");
  });
});

it("scrolls and focuses the requested banked-reset section after overlay autofocus", async () => {
  let onFrame: FrameRequestCallback | undefined;
  const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => {
    onFrame = callback;
    return 1;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  await render(<BankedResetsList data={inventory()} loading={false} hostName="One" focusOnMount />);
  const section = container.querySelector("section")!;
  section.scrollIntoView = vi.fn();
  expect(requestFrame).toHaveBeenCalledTimes(1);
  expect(document.activeElement).not.toBe(section);
  await act(async () => { onFrame!(0); });
  expect(section.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  expect(document.activeElement).toBe(section);
});

it("shows compact provider rows, keeps hover details, and opens the reset account without nested buttons", async () => {
  const claude = { ...provider, id: "claude-code", displayName: "Claude" };
  const providers = [provider, claude];
  const state: usageStore.UsageState = {
    data: { providers, fetchedAt: new Date(NOW).toISOString(), error: null, showStrip: true }, error: null, loading: false,
  };
  vi.spyOn(usageStore, "getUsageState").mockReturnValue(state);
  const onOpen = vi.fn();
  await render(<BankedResetsProvider providers={providers} active>
    <UsageBar onOpen={onOpen} />
  </BankedResetsProvider>);
  expect(container.querySelectorAll('button[aria-label^="Codex:"]')).toHaveLength(1);
  expect(container.querySelectorAll('button[aria-label^="Claude:"]')).toHaveLength(1);
  expect(container.querySelector("button button")).toBeNull();
  expect(container.textContent).toContain("52%");
  expect(container.textContent).toContain("0.7× pace");
  expect(container.textContent).not.toContain("today");
  expect(container.textContent).not.toContain("Σ");
  const claudeRow = container.querySelector<HTMLButtonElement>('button[aria-label^="Claude ·"]')!;
  expect(claudeRow.title).toContain("0.7× pace");
  expect(claudeRow.title).toContain("52% used");
  expect(claudeRow.textContent).toBe("W0.7× pace· 52% used");
  await click(claudeRow);
  expect(onOpen).toHaveBeenLastCalledWith();
  await click(badge());
  expect(onOpen).toHaveBeenCalledWith(provider);
  await click(container.querySelector<HTMLButtonElement>('button[aria-label^="Claude:"]')!);
  expect(onOpen).toHaveBeenLastCalledWith(claude);
  expect(rpc.mock.calls.every(([method]) => method === "getBankedResets")).toBe(true);
});

function claudeInventory(count = 1): BankedResets {
  return { ...inventory(count),
    credits: count === 0 ? [] : [{ id: "grant", title: "Launch reset", remaining: count, clears: ["five_hour", "seven_day"], usableNow: false, supported: null, expiresAt: "2026-10-03T12:00:00Z" }],
    sessionReset: { availability: "unavailable", reason: "not_at_wall", nextAvailableAt: null },
  };
}
const claudeBadge = () => container.querySelector<HTMLButtonElement>('button[aria-label^="Claude:"]')!;

describe("Claude limit resets", () => {
  const claude = { ...provider, id: "claude-code", displayName: "Claude" };
  it("explains the confirmed unavailable session reset without suggesting a missing reading", async () => {
    await render(<BankedResetsList providerId="claude-code" data={claudeInventory(0)} loading={false} hostName="One" now={NOW} />);
    const availability = container.querySelector('[aria-label="5-hour reset availability"]')!;
    expect.soft(availability.textContent).toContain("Not available · session limit not reached");
    expect.soft(availability.textContent).not.toContain("Eligibility will be checked again later");
    expect.soft(container.textContent).toContain("0 saved");
    expect.soft(container.textContent).not.toContain("No saved resets available.");
    expect.soft(container.textContent).not.toContain("Saved resets, not scheduled quota resets.");
  });
  it("shares refreshes, shows scope/expiry, and never counts conditional availability", async () => {
    rpc.mockResolvedValue(claudeInventory(2));
    await render(surfaces([claude]));
    expect(claudeBadge().textContent).toBe("↺2");
    expect(claudeBadge().title).toContain("2 saved resets");
    expect(claudeBadge().title).not.toContain("Some reset details are unavailable");
    expect(claudeBadge().className).toContain("text-amber-600");
    const section = container.querySelector("section")!;
    expect(section.getAttribute("aria-label")).toBe("Claude limit resets");
    expect(section.querySelector("li")?.textContent).toContain("Launch reset ×2");
    expect(section.textContent).toContain("Clears session + weekly");
    expect(section.textContent).toContain("Not redeemable now");
    expect(section.textContent).toContain("Not available · session limit not reached");
    expect(section.querySelector("time")?.dateTime).toBe("2026-10-03T12:00:00Z");
    const syntheticSessionReset: BankedResets["sessionReset"] = { availability: "available", reason: null, nextAvailableAt: null };
    rpc.mockResolvedValue({ ...claudeInventory(0), sessionReset: syntheticSessionReset });
    await click(container.querySelector<HTMLButtonElement>("[data-refresh]")!);
    expect(rpc).toHaveBeenLastCalledWith("getBankedResets", { hostId: target.hostId, providerId: "claude-code", force: true });
    expect(claudeBadge().textContent).toBe("↺0");
    expect(claudeBadge().className).toContain("opacity-50");
    expect(section.textContent).toContain("Available at last update");
    expect(section.textContent).toContain("Session only; the weekly limit still applies.");
    expect(section.querySelector('[title="Conditional session reset, separate from the saved balance."]')).not.toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(2);
    expect(section.querySelector("button")).toBeNull();
  });
  it("keeps balances and focus destinations separate for identical emails on one host", async () => {
    rpc.mockImplementation(async (_method: string, input: { providerId: string }) => input.providerId === "codex" ? inventory(3) : claudeInventory(1));
    await render(<BankedResetsProvider providers={[provider, claude]} active>
      <BankedResetsBadge target={provider} onOpen={() => {}} now={NOW} />
      <BankedResetsSection {...provider} />
      <BankedResetsBadge target={claude} onOpen={() => {}} now={NOW} />
      <BankedResetsSection {...claude} />
    </BankedResetsProvider>);
    expect(badge().textContent).toBe("↺3");
    expect(claudeBadge().textContent).toBe("↺1");
    expect(bankedResetSectionId(provider)).not.toBe(bankedResetSectionId(claude));
    expect(document.getElementById(bankedResetSectionId(claude))?.textContent).toContain("1 saved");
    expect(document.getElementById(bankedResetSectionId(provider))?.textContent).toContain("3 banked");
  });
  it("rejects another account's session status even when the saved inventory is unavailable", async () => {
    rpc.mockResolvedValue({ ...claudeInventory(), status: "unsupported", availableCount: null, credits: [], accountKey: "other", accountEmail: "other@example.test", sessionReset: { availability: "available", reason: null, nextAvailableAt: null } });
    await render(surfaces([claude]));
    expect(claudeBadge()).toBeNull();
    expect(container.querySelector("section")).toBeNull();
    expect(container.textContent).not.toContain("Available at last update");
  });
  it("does not invent expiry or availability when a session availability time passes", async () => {
    const data = { ...claudeInventory(0), sessionReset: { availability: "unavailable" as const, reason: null, nextAvailableAt: "2026-10-01T12:01:00Z" } };
    await render(<BankedResetsList providerId="claude-code" data={data} loading={false} hostName="One" now={NOW} />);
    expect(container.textContent).toContain("Next availability reported:");
    expect(container.textContent).not.toContain("Expires");
    await render(<BankedResetsList providerId="claude-code" data={data} loading={false} hostName="One" now={NOW + 60_000} />);
    expect(container.textContent).toContain("Availability time passed — refresh");
    expect(container.textContent).not.toContain("Available at last update");
  });
  it("distinguishes a saved five-hour grant from conditional session availability", async () => {
    const data = claudeInventory();
    data.credits[0]!.clears = ["five_hour"];
    await render(<BankedResetsList providerId="claude-code" data={data} loading={false} hostName="One" now={NOW} />);
    expect(container.querySelector("li")?.textContent).toContain("Clears session");
    expect(container.querySelector('[aria-label="5-hour reset availability"]')?.textContent).toContain("Not available · session limit not reached");
  });
  it("names what each reset clears with the usage the grant reported, keeping raw meters in the tooltip", async () => {
    const data = claudeInventory();
    data.credits = [
      { id: "weekly", title: "One full limit reset (November 2026)", remaining: 1, clears: ["seven_day", "seven_day_overage_included"], usedPercent: { seven_day: 69, seven_day_overage_included: 5 }, usableNow: true, supported: null, expiresAt: "2026-10-28T15:00:00Z" },
      { id: "fable", title: "New model launch: one Fable reset", remaining: 1, clears: ["seven_day_overage_included"], usedPercent: { seven_day_overage_included: 5 }, usableNow: true, supported: null, expiresAt: "2027-01-24T07:59:00Z" },
    ];
    await render(<BankedResetsList providerId="claude-code" data={data} loading={false} hostName="One" now={NOW} />);
    const [weekly, fable] = [...container.querySelectorAll("li")];
    expect.soft(weekly!.textContent).toContain("Clears weekly · 69% used");
    expect.soft(fable!.textContent).toContain("Clears a second weekly meter · 5% used");
    expect.soft(fable!.textContent).toContain("One Fable reset");
    expect.soft(fable!.textContent).not.toContain("New model launch");
    expect.soft(fable!.querySelector('[title^="New model launch"]')?.getAttribute("title")).toBe("New model launch: one Fable reset");
    expect.soft(fable!.querySelector('[title^="Claude meters"]')?.getAttribute("title")).toBe("Claude meters: seven_day_overage_included 5%");
    expect.soft(weekly!.querySelector("time")?.textContent).toBe("27d");
    expect.soft(fable!.querySelector("time")?.textContent).toBe("114d");
    expect.soft(container.textContent).not.toContain("×1");
  });
  it("does not attribute one meter's usage to a grant that clears several unrecognised meters", async () => {
    const data = claudeInventory();
    data.credits[0] = { ...data.credits[0]!, remaining: 1, clears: ["seven_day_opus", "seven_day_sonnet"], usedPercent: { seven_day_opus: 40, seven_day_sonnet: 10 } };
    await render(<BankedResetsList providerId="claude-code" data={data} loading={false} hostName="One" now={NOW} />);
    const tag = container.querySelector('li [title^="Claude meters"]');
    expect.soft(tag?.textContent).toBe("Clears other weekly meters");
    expect.soft(tag?.getAttribute("title")).toBe("Claude meters: seven_day_opus 40%, seven_day_sonnet 10%");
  });
  it("does not claim a Codex reset never expires when its expiry is unreported", async () => {
    const data = inventory(1);
    data.credits[0] = { ...data.credits[0]!, expiresAt: null };
    await render(<BankedResetsList data={data} loading={false} hostName="One" now={NOW} />);
    expect.soft(container.querySelector("li time")?.getAttribute("title")).toBe("Expiry not reported");
    expect.soft(container.textContent).not.toContain("No expiry");
  });
  it("flags resets expiring within a week and ones that expired since the last read", async () => {
    const data = claudeInventory();
    await render(<BankedResetsList providerId="claude-code" data={data} loading={false} hostName="One" now={NOW} />);
    expect(container.querySelector("li time")?.className).toContain("text-amber-600");
    await render(<BankedResetsList providerId="claude-code" data={data} loading={false} hostName="One" now={Date.parse("2026-10-04T12:00:00Z")} />);
    expect(container.querySelector("li time")?.textContent).toBe("Expired");
    expect(container.textContent).toContain("1 saved at last update");
  });
});
