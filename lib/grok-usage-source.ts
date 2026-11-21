import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { GROK_PROVIDER_ID } from "./grok-provider";
import { createHostUsageSource } from "./host-usage-source";
import type { SourceUsage, SourceWindow, UsageSource } from "./usage-source-contract";

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
  return createHostUsageSource(
    bb,
    {
      providerId: GROK_PROVIDER_ID,
      resourcePrefix: RESOURCE_PREFIX,
      label: "Grok Build (usage)",
      failureMessage: "Grok Build usage could not be read.",
      read: async (hostId) => toSourceUsage((await bb.sdk.system.usageLimits({ hostId }))[GROK_PROVIDER_ID]),
    },
    now,
  );
}
