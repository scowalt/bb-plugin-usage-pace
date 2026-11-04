import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { GROK_PROVIDER_ID } from "./grok-provider";
import type { SourceResource, SourceResourceEntry, SourceUsage, SourceWindow, UsageSource } from "./usage-source-contract";

const CACHE_MS = 5 * 60_000;

const RESOURCE_PREFIX = "grok:";

type UsageLimits = Awaited<ReturnType<BbPluginApi["sdk"]["system"]["usageLimits"]>>;
type RawUsage = NonNullable<UsageLimits[string]>;

function windowKind(label: string): SourceWindow["kind"] {
  if (/\bweek(ly)?\b|\b7\s*d\b/iu.test(label)) return "weekly";
  if (/\bdaily\b|\b1\s*d\b/iu.test(label)) return "daily";
  if (/\bfive[- ]hour\b|\b5\s*h/iu.test(label)) return "five-hour";
  return "custom";
}

function windowId(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "window";
}

export function toSourceUsage(raw: RawUsage | undefined): SourceUsage {
  const empty = { plan: null, accountEmail: null, planLabel: null };
  if (raw === undefined) return { status: "error", ...empty, message: "No usage reported." };
  switch (raw.status) {
    case "ok":
      return {
        status: "ok",
        plan: null,
        accountEmail: raw.accountEmail,
        planLabel: raw.planLabel,
        windows: raw.windows.map((window) => ({
          kind: windowKind(window.label),
          id: windowId(window.label),
          label: window.label,
          usedPercent: Math.max(0, window.usedPercent),
          resetsAt: window.resetsAt,
          model: null,
          cost:
            window.cost && window.cost.limitUsdCents > 0
              ? { usedUsdCents: Math.max(0, window.cost.usedUsdCents), limitUsdCents: window.cost.limitUsdCents }
              : null,
        })),
      };
    case "error":
      return { status: "error", ...empty, message: raw.message };
    default:
      return { status: raw.status, ...empty };
  }
}

export function createGrokUsageSource(
  bb: Pick<BbPluginApi, "sdk">,
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
        .then((providers) => providers.some((provider) => provider.id === GROK_PROVIDER_ID))
        .catch(() => false);
      if (!listed) continue;
      resources.push({
        accountKey: null,
        id: `${RESOURCE_PREFIX}${host.id}`,
        providerId: GROK_PROVIDER_ID,
        label: "Grok Build (usage)",
        scope: { kind: "host", hostId: host.id, hostName: host.name },
      });
    }
    return { resources };
  }

  async function getResource({ resourceId, refresh }: { resourceId: string; refresh: boolean }) {
    if (!resourceId.startsWith(RESOURCE_PREFIX)) throw new Error(`Unknown resource: ${resourceId}`);
    const hostId = resourceId.slice(RESOURCE_PREFIX.length);
    const cached = cache.get(resourceId);
    if (!refresh && cached !== undefined && now() - cached.at < CACHE_MS) return cached.value;

    let usage: SourceUsage;
    try {
      const limits = await bb.sdk.system.usageLimits({ hostId });
      usage = toSourceUsage(limits[GROK_PROVIDER_ID]);
    } catch (cause) {
      usage = {
        status: "error",
        plan: null,
        accountEmail: null,
        planLabel: null,
        message: cause instanceof Error ? cause.message : "Grok Build usage could not be read.",
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
    owns: (resourceId) => resourceId.startsWith(RESOURCE_PREFIX),
    "provider-usage.v1.listResources": () => listResources(),
    "provider-usage.v1.getResource": getResource,
  };
}
