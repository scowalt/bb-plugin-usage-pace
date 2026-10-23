import type { UsageAccount } from "../lib/usage-accounts";

export const NOW = Date.parse("2026-10-23T12:00:00Z");
export const HOUR = 3_600_000;
export const at = (hours: number) => new Date(NOW + hours * HOUR).toISOString();
export function makeAccount(overrides: Partial<UsageAccount> = {}): UsageAccount {
  return {
    id: "claude-code", displayName: "Claude Code", hostId: "beelink", hostName: "Beelink",
    logoUrl: null, icon: null, iconTint: null, status: "ok", message: null,
    accountEmail: "a@example.test", planLabel: "Max 20x", accountKey: "anthropic:account:a", accountLabel: "a",
    plan: { id: "max", multiplier: 20 }, weight: 20, observedAt: NOW, stale: false,
    sources: [{ pluginId: "provider-claude-code", label: "Claude Code provider", resourceId: "host-a", scope: { kind: "host", hostId: "beelink", hostName: "Beelink" } }],
    hosts: [{ id: "beelink", name: "Beelink" }],
    windows: [
      { id: "five-hour", kind: "five-hour", model: null, label: "Current session", weekly: false, usedPercent: 32, resetsAt: at(2) },
      { id: "weekly", kind: "weekly", model: null, label: "Weekly limit", weekly: true, usedPercent: 52, resetsAt: at(48) },
      { id: "fable", kind: "weekly", model: "fable", label: "Fable", weekly: true, usedPercent: 1, resetsAt: at(48) },
    ], ...overrides,
  };
}
