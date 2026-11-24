import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { accountSchema, type UsageAccount } from "./usage-accounts";
import type { SignedOutMachine } from "./signed-out-contract";

export type Provider = Awaited<ReturnType<BbPluginApi["sdk"]["providers"]["list"]>>[number];
export type Source = { pluginId: string; displayName: string };

const names: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", "usage-pace-grok": "Grok Build (usage)", "usage-pace-antigravity": "Google Antigravity (usage)" };
const disabledProviderMarks: Record<string, { logoUrl: string; iconTint: { light: string; dark: string } | null }> = {
  "claude-code": { logoUrl: "/api/v1/system/providers/claude-code/logo", iconTint: { light: "#D97757", dark: "#D97757" } },
  codex: { logoUrl: "/api/v1/system/providers/codex/logo", iconTint: null },
};

export function providerFields(providerId: string, provider: Provider | undefined) {
  return {
    displayName: provider?.displayName ?? names[providerId] ?? providerId,
    logoUrl: provider ? provider.logoUrl ?? null : disabledProviderMarks[providerId]?.logoUrl ?? null,
    icon: provider?.icon?.glyph ? { glyph: provider.icon.glyph } : null,
    iconTint: provider ? provider.strings?.iconTint ?? null : disabledProviderMarks[providerId]?.iconTint ?? null,
  };
}

export function signedOutAccount(machine: SignedOutMachine, source: Source, hostName: string, provider: Provider | undefined): UsageAccount {
  const fields = providerFields(machine.providerId, provider);
  return accountSchema.parse({
    id: machine.providerId, ...fields, hostId: machine.hostId, hostName,
    status: machine.status, message: null, accountEmail: null, planLabel: null, windows: [],
    accountKey: machine.accountKey, observedAt: null, plan: null, accountLabel: fields.displayName, weight: null, stale: true,
    hosts: [{ id: machine.hostId, name: hostName }],
    sources: [{ pluginId: source.pluginId, label: source.displayName, resourceId: `signed-out:${machine.hostId}`, scope: { kind: "host", hostId: machine.hostId, hostName } }],
  });
}
