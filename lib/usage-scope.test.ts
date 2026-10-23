import { describe, expect, it } from "vitest";
import type { UsageProvider, UsageSnapshot } from "../server";
import { compactUsageRows } from "./compact-usage";
import { usageForDisplay } from "./usage-scope";
import type { UsageState } from "./usage-store";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const server: UsageProvider = {
  id: "claude-code", displayName: "Claude Code", hostId: "server", hostName: "Server",
  accountEmail: "shared@example.test", status: "ok", message: null,
  accountKey: "one", accountLabel: "shared", observedAt: NOW, plan: null, weight: null, stale: false,
  sources: [], hosts: [{ id: "server", name: "Server" }],
  logoUrl: null, icon: null, iconTint: null, planLabel: null,
  windows: [{ label: "Weekly limit", weekly: true, usedPercent: 52, resetsAt: "2026-10-03T12:00:00Z" }],
};
const remote: UsageProvider = { ...server, hostId: "remote", hostName: "Remote", hosts: [{ id: "remote", name: "Remote" }] };
function state(overrides: Partial<UsageSnapshot> = {}): UsageState {
  return { data: {
    providers: [remote, server, { ...remote, accountEmail: "remote@example.test" }],
    fetchedAt: new Date(NOW).toISOString(), error: null,
    serverOnly: true, serverHostId: "server", serverHostError: null, ...overrides,
  }, error: null, loading: false };
}

describe("usage display scope", () => {
  it("preserves the all-host view by default and while loading its first snapshot", () => {
    for (const serverOnly of [false, undefined]) {
      const input = state({ serverOnly });
      expect(usageForDisplay(input)).toBe(input);
    }
    const input: UsageState = { data: null, loading: true, error: null };
    expect(usageForDisplay(input)).toBe(input);
  });

  it("filters by server host ID before account deduplication without changing collection", () => {
    const input = state();
    const display = usageForDisplay(input);
    expect(display.data?.providers).toEqual([server]);
    expect(compactUsageRows(display, NOW)[0]?.provider).toBe(server);
    expect(input.data?.providers).toHaveLength(3);
    expect(usageForDisplay({ ...input, data: { ...input.data!, serverOnly: false } }).data?.providers).toHaveLength(3);
  });

  it("keeps separate provider accounts and providers with missing account identities on the server", () => {
    const providers: UsageProvider[] = [server, { ...server, id: "codex" }, { ...server, accountEmail: null }, remote];
    expect(usageForDisplay(state({ providers })).data?.providers).toEqual(providers.slice(0, 3));
  });

  it.each([null, undefined, "missing"])('never falls back to another host when the server ID is %s', serverHostId => {
    const display = usageForDisplay(state({ serverHostId }));
    expect(display.data?.providers).toEqual([]);
    expect(compactUsageRows(display, NOW)).toEqual([]);
    if (!serverHostId) expect(display.data?.error).toContain("Server host is not available");
  });

  it("removes cached server rows when the server is offline and retains the actionable error", () => {
    const error = "Server host is offline. Reconnect it, then refresh usage.";
    const display = usageForDisplay(state({ serverHostError: error }));
    expect(display.data?.providers).toEqual([]);
    expect(display.data?.error).toBe(error);
  });

  it("retains collection-level warnings without treating healthy server accounts as failed", () => {
    const input = state({ error: "Claude Accounts: could not list resources" });
    const display = usageForDisplay(input);
    expect(display.data?.error).toBe(input.data?.error);
    expect(compactUsageRows(display, NOW)[0]?.status.glyph).toBe("●");
    expect(display.data?.serverHostError).toBeNull();
  });

  it("keeps transport errors distinct from server-specific collection errors", () => {
    const input = { ...state(), error: "Could not refresh usage" };
    expect(usageForDisplay(input).error).toBe(input.error);
    const display = usageForDisplay(state({ serverHostError: "Server: read failed" }));
    expect(display.data?.error).toBe("Server: read failed");
    expect(display.data?.providers).toEqual([]);
  });
});
