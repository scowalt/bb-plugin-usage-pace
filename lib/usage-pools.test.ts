import { describe, expect, it } from "vitest";
import { describePool, usagePools } from "./usage-pools";
import { makeAccount, NOW, at } from "../tests/usage-fixtures";
import type { UsageAccount } from "./usage-accounts";

const pool = (accounts: UsageAccount[]) => usagePools(accounts, new Date(NOW).toISOString(), NOW)[0]!;
function account(key: string, weight: number | null, usedPercent: number, hoursRemaining = 84): UsageAccount {
  const base = makeAccount({ accountKey: key, weight });
  return { ...base, windows: [{ ...base.windows[1]!, usedPercent, resetsAt: at(hoursRemaining) }] };
}

describe("provider pools", () => {
  it("only appears for two or more accounts", () => {
    expect(usagePools([makeAccount()], at(0), NOW)).toEqual([]);
  });
  it("weights use by plan and pace by weighted elapsed budget rather than averaging account ratios", () => {
    const result = pool([account("a", 20, 100, 84), account("b", 5, 0, 42), account("c", 1, 0, 126)]);
    expect(result.usedPercent).toBeCloseTo(2000 / 26);
    expect(result.pace).toBeCloseTo(2000 / (20 * 50 + 5 * 75 + 1 * 25));
    expect(result).toMatchObject({ accounts: 3, available: 2, partial: false, exhausted: false });
    expect(describePool(result, NOW)).toContain("(est.)");
    expect(result).not.toHaveProperty("runsOutAtMs");
  });
  it("includes a newly started account's elapsed budget even when its individual pace is too early", () => {
    const result = pool([account("a", 20, 70, 84), account("b", 5, 0, 167)]);
    expect(result.pace).toBeCloseTo(20 * 70 / (20 * 50 + 5 * 100 / 168));
  });
  it("marks unknown plans, failed reads, and missing weekly windows partial without fabricating zero usage", () => {
    const result = pool([account("a", 20, 50), account("b", null, 90), { ...account("c", 5, 0), stale: true }]);
    expect(result).toMatchObject({ usedPercent: 50, partial: true, unknown: 1 });
    expect(pool([account("a", null, 0), account("b", null, 0)])).toMatchObject({ usedPercent: null, pace: null, partial: true });
  });
  it("does not mistake exhausted model-family limits for exhausted shared quota", () => {
    const base = makeAccount();
    const result = pool([makeAccount({ windows: [...base.windows, { ...base.windows[2]!, usedPercent: 100 }] }), account("b", 5, 20)]);
    expect(result).toMatchObject({ available: 2, exhausted: false, models: [{ model: "fable", exhausted: 1, accounts: 2 }] });
    expect(describePool(result, NOW)).toContain("fable 1/2 exhausted");
  });
  it("revives at the earliest account renewal, with each account needing its latest exhausted shared window", () => {
    const a = account("a", 20, 100, 8);
    a.windows.push({ ...makeAccount().windows[0]!, usedPercent: 100, resetsAt: at(2) });
    const result = pool([a, account("b", 5, 100, 4)]);
    expect(result).toMatchObject({ exhausted: true, available: 0, resetsAt: NOW + 4 * 3_600_000 });
    expect(pool([a, { ...account("b", 5, 100), stale: true }]).exhausted).toBe(false);
  });
  it("retains overage and unknown reset/pace rather than capping or inventing numbers", () => {
    const a = account("a", 1, 120);
    const b = account("b", 1, 100);
    a.windows[0]!.resetsAt = null;
    b.windows[0]!.resetsAt = null;
    expect(pool([a, b])).toMatchObject({ usedPercent: 110, pace: null, exhausted: true, resetsAt: null });
  });
});
