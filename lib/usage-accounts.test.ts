import { describe, expect, it } from "vitest";
import { accountId, isWeeklyWindow, mergeAccounts, parsePairs, withAccountSettings } from "./usage-accounts";
import { makeAccount, NOW } from "../tests/usage-fixtures";
import { paceForWindows } from "./pace";

describe("quota account identities", () => {
  it("merges the same issued identity across two sources and machines using the freshest measurement", () => {
    const host = makeAccount();
    const otherHost = makeAccount({ hosts: [{ id: "mac", name: "MacBook" }], sources: [{ ...host.sources[0]!, resourceId: "mac-a" }], observedAt: NOW - 1000 });
    const shared = makeAccount({ hostId: "", hosts: [], observedAt: NOW + 1000, accountEmail: "renamed@example.test", plan: { id: "pro", multiplier: null },
      windows: [{ ...host.windows[1]!, usedPercent: 71 }], sources: [{ pluginId: "claude-accounts", label: "Claude Accounts", resourceId: "a", scope: { kind: "shared" } }] });
    const [account] = mergeAccounts([host, shared, otherHost]);
    expect(account).toMatchObject({ accountKey: host.accountKey, windows: shared.windows, observedAt: shared.observedAt, plan: shared.plan, accountEmail: shared.accountEmail });
    expect(account?.hosts.map(host => host.name)).toEqual(["Beelink", "MacBook"]);
    expect(account?.sources).toHaveLength(3);
  });
  it("never merges null identities or two issued identities with the same email", () => {
    expect(mergeAccounts([makeAccount({ accountKey: null }), makeAccount({ accountKey: null }), makeAccount(), makeAccount({ accountKey: "anthropic:account:b" })])).toHaveLength(4);
    expect(accountId(makeAccount())).not.toBe(accountId(makeAccount({ accountKey: "anthropic:account:b" })));
  });
  it.each(["stale", "failed"])("keeps an older healthy duplicate authoritative when another source is %s, regardless of row order", state => {
    const healthy = makeAccount({ observedAt: NOW - 90_000 });
    const unusable = makeAccount({
      status: state === "failed" ? "error" : "ok", stale: state === "stale", observedAt: NOW - 30_000,
      accountEmail: null, plan: null, planLabel: null, message: "source offline", windows: [],
    });
    for (const rows of [[unusable, healthy], [healthy, unusable]]) {
      expect(mergeAccounts(rows)[0]).toMatchObject({
        status: "ok", stale: false, observedAt: NOW - 90_000, message: "source offline",
        accountEmail: "a@example.test", plan: { id: "max", multiplier: 20 }, planLabel: "Max 20x", windows: healthy.windows,
      });
    }
  });
  it("uses the newest last-success timestamp when every source is stale, regardless of row order", () => {
    const older = makeAccount({ stale: true, observedAt: NOW - 90_000 });
    const newer = makeAccount({ stale: true, status: "error", observedAt: NOW - 30_000,
      windows: [{ ...older.windows[1]!, usedPercent: 71 }], message: "source offline" });
    for (const rows of [[older, newer], [newer, older]]) {
      expect(mergeAccounts(rows)[0]).toMatchObject({
        stale: true, status: "error", observedAt: NOW - 30_000, windows: newer.windows, message: "source offline",
      });
    }
  });
});

it("uses explicit window kinds before label heuristics, including unlabelled model families", () => {
  expect(isWeeklyWindow({ label: "Fable", kind: "weekly" })).toBe(true);
  expect(isWeeklyWindow({ label: "Weekly", kind: "daily" })).toBe(false);
  expect(isWeeklyWindow({ label: "7-day limit" })).toBe(true);
  const windows = makeAccount().windows.map(window => ({ ...window, label: "Opaque label" }));
  expect(paceForWindows(windows, NOW).map(pace => pace?.windowMs)).toEqual([5 * 3_600_000, 168 * 3_600_000, 168 * 3_600_000]);
});

it("uses aliases and positive weight overrides without using display labels as identity", () => {
  const account = makeAccount({ accountEmail: "A@EXAMPLE.TEST" });
  expect(withAccountSettings(account, parsePairs("a@example.test=Work"), parsePairs("a@example.test=5"))).toMatchObject({ accountKey: account.accountKey, accountLabel: "Work", weight: 5 });
  expect(withAccountSettings(account, new Map(), parsePairs("a@example.test=0"))).toMatchObject({ weight: 20, accountLabel: "A" });
  expect(withAccountSettings(makeAccount({ plan: { id: "pro", multiplier: null }, accountEmail: null }), new Map(), new Map())).toMatchObject({ weight: 1 });
  expect(withAccountSettings(makeAccount({ plan: null }), new Map(), new Map())).toMatchObject({ weight: null });
});
