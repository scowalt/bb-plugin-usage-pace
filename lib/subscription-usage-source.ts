import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ResetProviderId } from "./banked-resets-contract";
import type { HostUsage } from "./subscription-usage";
import type { SourceResource, SourceResourceEntry, UsageSource } from "./usage-source-contract";

const CACHE_MS = 5 * 60_000;
const PROVIDERS: { id: ResetProviderId; label: string }[] = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
];

export type ReadHostUsage = (hostId: string, providerId: ResetProviderId) => Promise<HostUsage>;

function parseResourceId(resourceId: string): { providerId: ResetProviderId; hostId: string } | null {
  const provider = PROVIDERS.find(candidate => resourceId.startsWith(`${candidate.id}:`));
  const hostId = provider === undefined ? "" : resourceId.slice(provider.id.length + 1);
  return provider === undefined || hostId === "" ? null : { providerId: provider.id, hostId };
}

export function createSubscriptionUsageSource(
  bb: Pick<BbPluginApi, "sdk">,
  readHostUsage: ReadHostUsage,
  now: () => number = Date.now,
): UsageSource {
  const cache = new Map<string, { at: number; value: SourceResource }>();
  const lastSuccess = new Map<string, number>();

  async function listResources() {
    const resources: SourceResourceEntry[] = [];
    for (const host of await bb.sdk.hosts.list()) {
      if (host.status === "disconnected") continue;
      const listed = await bb.sdk.providers.list({ hostId: host.id, capability: "usage" }).catch(() => null);
      if (listed === null) continue;
      for (const provider of PROVIDERS) {
        if (listed.some(entry => entry.id === provider.id)) continue;
        const id = `${provider.id}:${host.id}`;
        resources.push({
          accountKey: cache.get(id)?.value.accountKey ?? null,
          id, providerId: provider.id, label: provider.label,
          scope: { kind: "host", hostId: host.id, hostName: host.name },
        });
      }
    }
    return { resources };
  }

  async function getResource({ resourceId, refresh }: { resourceId: string; refresh: boolean }): Promise<SourceResource> {
    const parsed = parseResourceId(resourceId);
    if (parsed === null) throw new Error(`Unknown resource: ${resourceId}`);
    const cached = cache.get(resourceId);
    if (!refresh && cached !== undefined && now() - cached.at < CACHE_MS) return cached.value;
    let read: HostUsage;
    try {
      read = await readHostUsage(parsed.hostId, parsed.providerId);
    } catch (cause) {
      read = {
        accountKey: cached?.value.accountKey ?? null,
        usage: {
          status: "error", plan: null, accountEmail: null, planLabel: null,
          message: cause instanceof Error ? cause.message : "Usage could not be read from this machine.",
        },
      };
    }
    if (read.usage.status === "ok") lastSuccess.set(resourceId, now());
    const value: SourceResource = { accountKey: read.accountKey, observedAt: lastSuccess.get(resourceId) ?? null, usage: read.usage };
    cache.set(resourceId, { at: now(), value });
    return value;
  }

  return {
    owns: resourceId => parseResourceId(resourceId) !== null,
    "provider-usage.v1.listResources": listResources,
    "provider-usage.v1.getResource": getResource,
  };
}
