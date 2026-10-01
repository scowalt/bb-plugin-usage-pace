import { describe, expect, it } from "vitest";
import { bankedResetBadge } from "./banked-reset-badge";
import { bankedResetsUnavailable, type BankedResets } from "./banked-resets-contract";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const DAY = 86_400_000;
function data(count: number, days: (number | null)[] = []): BankedResets {
  return { status: "ok", accountEmail: null, fetchedAt: new Date(NOW).toISOString(), availableCount: count, message: null,
    credits: days.map((day, i) => ({ id: String(i), title: "Reset", expiresAt: day === null ? null : new Date(NOW + day * DAY).toISOString(), supported: true })) };
}

describe("footer banked-reset badge", () => {
  it("distinguishes loading, unavailable and a confirmed zero", () => {
    expect(bankedResetBadge(null, true, NOW).text).toBe("…");
    expect(bankedResetBadge(bankedResetsUnavailable("Offline"), false, NOW)).toMatchObject({ text: "?", title: "Offline", empty: false });
    expect(bankedResetBadge(data(0), false, NOW)).toMatchObject({ text: "0", empty: true, warning: false });
  });
  it("uses the authoritative count even with no details", () => {
    const badge = bankedResetBadge(data(3), false, NOW);
    expect(badge).toMatchObject({ text: "3", warning: false, empty: false });
    expect(badge.title).toContain("Expiry not reported");
    expect(badge.title).toContain("Some reset details are unavailable");
  });
  it("selects the earliest expiration even from an unsorted list", () => {
    const badge = bankedResetBadge(data(3, [30, 2, null]), false, NOW);
    expect(badge).toMatchObject({ text: "3", warning: true });
    expect(badge.title).toContain("Next expires in 2d 0h");
  });
  it("does not claim to know the earliest expiry of omitted details", () => {
    expect(bankedResetBadge(data(3, [10]), false, NOW).title).toContain("Earliest reported expiry");
  });
  it("warns at seven days but not beyond", () => {
    expect(bankedResetBadge(data(1, [7]), false, NOW).warning).toBe(true);
    expect(bankedResetBadge(data(1, [7.01]), false, NOW).warning).toBe(false);
    expect(bankedResetBadge(data(1, [null]), false, NOW).warning).toBe(false);
  });
  it("does not silently subtract expired details from the provider count", () => {
    const badge = bankedResetBadge(data(3, [0, 1, 2]), false, NOW);
    expect(badge.text).toBe("?");
    expect(badge.title).toContain("3 banked resets at last update");
    expect(badge.title).toContain("has expired");
  });
  it("treats a missing count as unknown, not zero", () => {
    expect(bankedResetBadge({ ...data(0), availableCount: null }, false, NOW).text).toBe("?");
  });
  it("uses singular wording and marks an ongoing refresh", () => {
    expect(bankedResetBadge(data(1, [20]), true, NOW).title).toMatch(/^1 banked reset ·.*Refreshing/);
  });
});
