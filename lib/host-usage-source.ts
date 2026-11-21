import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { SourceResource, SourceResourceEntry, SourceUsage, UsageSource } from "./usage-source-contract";

const CACHE_MS = 5 * 60_000;

export type HostUsageSpec = {
  providerId: string;
  resourcePrefix: string;
  label: string;
  failureMessage: string;
  read: (hostId: string) => Promise<SourceUsage>;
};

export function createHostUsageSource(
  bb: Pick<BbPluginApi, "sdk">,
  spec: HostUsageSpec,
  now: () => number = Date.now,
): UsageSource {
  const cache = new Map<string, { at: number; value: SourceResource }>();
  const lastSuccess = new Map<string, number>();

  async function listResources() {
    const hosts = await bb.sdk.hosts.list();
    const resources: SourceResourceEntry[] = [];
    for (const host of hosts) {
      if (host.status === "disconnected") continue;
      const listed = await bb.sdk.providers
        .list({ hostId: host.id, capability: "usage" })
        .then((providers) => providers.some((provider) => provider.id === spec.providerId))
        .catch(() => false);
      if (!listed) continue;
      resources.push({
        accountKey: null,
        id: `${spec.resourcePrefix}${host.id}`,
        providerId: spec.providerId,
        label: spec.label,
        scope: { kind: "host", hostId: host.id, hostName: host.name },
      });
    }
    return { resources };
  }

  async function getResource({ resourceId, refresh }: { resourceId: string; refresh: boolean }) {
    if (!resourceId.startsWith(spec.resourcePrefix)) throw new Error(`Unknown resource: ${resourceId}`);
    const hostId = resourceId.slice(spec.resourcePrefix.length);
    const cached = cache.get(resourceId);
    if (!refresh && cached !== undefined && now() - cached.at < CACHE_MS) return cached.value;

    let usage: SourceUsage;
    try {
      usage = await spec.read(hostId);
    } catch (cause) {
      usage = {
        status: "error",
        plan: null,
        accountEmail: null,
        planLabel: null,
        message: cause instanceof Error ? cause.message : spec.failureMessage,
      };
    }
    if (usage.status === "ok") lastSuccess.set(resourceId, now());
    const value: SourceResource = {
      accountKey: null,
      observedAt: lastSuccess.get(resourceId) ?? null,
      usage,
    };
    cache.set(resourceId, { at: now(), value });
    return value;
  }

  return {
    owns: (resourceId) => resourceId.startsWith(spec.resourcePrefix),
    "provider-usage.v1.listResources": () => listResources(),
    "provider-usage.v1.getResource": getResource,
  };
}
