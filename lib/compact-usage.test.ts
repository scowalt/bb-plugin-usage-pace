import { describe, expect, it } from "vitest";
import type { UsageProvider, UsageWindow } from "../server";
import type { UsageState } from "./usage-store";
import { compactUsageRows } from "./compact-usage";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const weekly: UsageWindow = { label: "Weekly limit", weekly: true, usedPercent: 52, resetsAt: "2026-10-03T12:00:00Z" };
const session: UsageWindow = { label: "5-hour limit", weekly: false, usedPercent: 32, resetsAt: "2026-10-01T14:00:00Z" };
const provider: UsageProvider = {
  id: "claude-code", displayName: "Claude Code", hostId: "one", hostName: "One",
  accountEmail: "one@example.test", status: "ok", message: null,
  logoUrl: null, icon: null, iconTint: null, planLabel: null,
  windows: [session, weekly],
};
function state(providers = [provider]): UsageState {
  return { data: { providers, fetchedAt: new Date(NOW).toISOString(), error: null, showStrip: true }, loading: false, error: null };
}
function row(windows = provider.windows) {
  return compactUsageRows(state([{ ...provider, windows }]), NOW)[0]!;
}

describe("compact usage rows", () => {
  it("shows W then S, with used percentages and pace details behind the row", () => {
    const result = row();
    expect(result.windows.map(entry => [entry.label, entry.window.usedPercent])).toEqual([["W", 52], ["S", 32]]);
    expect(result.status).toEqual({ glyph: "●", tone: "ok", detail: "All quota windows last to reset at this rate." });
    expect(result.title).toContain("one@example.test · One");
    expect(result.title).toContain("Weekly limit: 52% used · resets in 2d 0h · 0.7× pace");
    expect(result.title).toContain("5-hour limit: 32% used");
  });

  it("deduplicates accounts across hosts but preserves distinct accounts and unknown accounts", () => {
    const providers = [provider, { ...provider, hostId: "two" }, { ...provider, accountEmail: "two@example.test" },
      { ...provider, accountEmail: null }, { ...provider, hostId: "two", accountEmail: null }];
    expect(compactUsageRows(state(providers), NOW)).toHaveLength(4);
  });

  it("skips providers without reportable quota windows", () => {
    expect(compactUsageRows(state([{ ...provider, status: "not_installed" }, { ...provider, windows: [] }]), NOW)).toEqual([]);
    expect(compactUsageRows({ data: null, error: null, loading: true }, NOW)).toEqual([]);
  });

  it("keeps weekly-only and session-only rows without fabricated percentages", () => {
    expect(row([weekly]).windows.map(entry => entry.label)).toEqual(["W"]);
    expect(row([session]).windows.map(entry => entry.label)).toEqual(["S"]);
  });

  it.each([
    ["Monthly credits", "M"], ["Daily limit", "D"], ["Credit balance", "Credit balance"], ["24h", "D"],
  ])("labels the fallback %s as %s, not as a session", (label, short) => {
    expect(row([{ ...session, label }]).windows[0]?.label).toBe(short);
  });

  it("uses every window for the status, including model limits hidden from the compact row", () => {
    const result = row([weekly, session, { ...weekly, label: "Weekly model limit", usedPercent: 90 }]);
    expect(result.windows).toHaveLength(2);
    expect(result.status.glyph).toBe("▲");
    expect(result.status.tone).toBe("critical");
    expect(result.title).toContain("Weekly model limit: 90% used");
    expect(result.title).toContain("before reset");
  });

  it("warns when the session runs out even if the weekly quota lasts", () => {
    expect(row([weekly, { ...session, usedPercent: 70 }]).status.glyph).toBe("▲");
  });

  it("shows time until the weekly quota runs out", () => {
    const result = row([{ ...weekly, usedPercent: 11, resetsAt: "2026-10-08T07:00:00Z" }]);
    expect(result.countdown?.label).toBe("out in 1d 16h");
    expect(result.countdown?.detail).toContain("Weekly limit");
    expect(result.title).toContain("out in 1d 16h");
  });

  it("uses the earliest run-out, including model windows hidden from the row", () => {
    const result = row([
      { ...weekly, usedPercent: 90 },
      { ...session, usedPercent: 70 },
      { ...session, label: "Session model limit", usedPercent: 90 },
    ]);
    expect(result.windows).toHaveLength(2);
    expect(result.countdown?.label).toBe("out in 20m");
    expect(result.countdown?.detail).toContain("Session model limit");
  });

  it("counts down from the snapshot's pace between refreshes", () => {
    const snapshot = state([{ ...provider, windows: [{ ...session, usedPercent: 90 }] }]);
    expect(compactUsageRows(snapshot, NOW)[0]?.countdown?.label).toBe("out in 20m");
    expect(compactUsageRows(snapshot, NOW + 60_000)[0]?.countdown?.label).toBe("out in 19m");
    expect(compactUsageRows(snapshot, NOW + 19.5 * 60_000)[0]?.countdown?.label).toBe("out in <1m");
    expect(compactUsageRows(snapshot, NOW + 21 * 60_000)[0]?.countdown?.label).toBe("out now (est.)");
    snapshot.data!.fetchedAt = new Date(NOW + 60_000).toISOString();
    expect(compactUsageRows(snapshot, NOW + 60_000)[0]?.countdown?.label).toBe("out in 20m");
  });

  it("shows out now for an exhausted window even without a known duration", () => {
    const result = row([{ ...weekly, label: "Credit balance", usedPercent: 100 }]);
    expect(result.countdown?.label).toBe("out now");
    expect(result.countdown?.detail).toContain("Credit balance");
  });

  it("omits the countdown for sustainable or unknown pace", () => {
    expect(row().countdown).toBeNull();
    expect(row([{ ...weekly, usedPercent: 1, resetsAt: "2026-10-08T07:00:00Z" }]).countdown).toBeNull();
    expect(row([{ ...weekly, resetsAt: null }]).countdown).toBeNull();
  });

  it("hides run-out estimates after failed refreshes, partial snapshots, or resets", () => {
    const snapshot = state([{ ...provider, windows: [{ ...session, usedPercent: 90 }] }]);
    expect(compactUsageRows({ ...snapshot, error: "offline" }, NOW)[0]?.countdown).toBeNull();
    snapshot.data!.error = "One host failed";
    expect(compactUsageRows(snapshot, NOW)[0]?.countdown).toBeNull();
    snapshot.data!.error = null;
    expect(compactUsageRows(snapshot, NOW + 2 * 3_600_000)[0]?.countdown).toBeNull();
  });

  it("uses an amber dot for a near-limit but sustainable rate", () => {
    expect(row([{ ...weekly, usedPercent: 65 }]).status).toMatchObject({ glyph: "●", tone: "warning" });
  });

  it("marks early and unknown pace as unknown, not healthy", () => {
    expect(row([{ ...session, usedPercent: 1, resetsAt: "2026-10-01T16:55:00Z" }]).status).toMatchObject({ glyph: "—", tone: null });
    expect(row([{ ...weekly, resetsAt: null }]).status.glyph).toBe("—");
    expect(row([{ ...weekly, resetsAt: "invalid" }]).status.glyph).toBe("—");
    expect(row([{ ...session, label: "Credit balance" }]).status.glyph).toBe("—");
  });

  it("warns for significant early usage even if another window is too early to judge", () => {
    const result = row([
      { ...weekly, usedPercent: 11, resetsAt: "2026-10-08T07:00:00Z" },
      { ...session, usedPercent: 1, resetsAt: "2026-10-01T16:55:00Z" },
    ]);
    expect(result.status).toMatchObject({ glyph: "▲", tone: "critical" });
    expect(result.title).toContain("3.7× pace");
    expect(result.status.detail).toContain("runs out before reset");
    expect(result.countdown?.label).toBe("out in 1d 16h");
  });

  it("still warns for exhausted quotas during the early window", () => {
    expect(row([{ ...session, usedPercent: 100, resetsAt: "2026-10-01T16:55:00Z" }]).status.glyph).toBe("▲");
  });

  it("marks failed refreshes, partial snapshots, and elapsed resets as unknown", () => {
    expect(compactUsageRows({ ...state(), error: "offline" }, NOW)[0]?.status).toMatchObject({ glyph: "—", tone: null });
    const partial = state();
    partial.data!.error = "One host failed";
    expect(compactUsageRows(partial, NOW)[0]?.title).toContain("Usage may be stale or incomplete. One host failed");
    const expired = row([{ ...weekly, resetsAt: new Date(NOW).toISOString() }]);
    expect(expired.status.glyph).toBe("—");
    expect(expired.title).toContain("Reset passed since last update");
    expect(expired.title).not.toContain("0.5× pace");
  });
});
