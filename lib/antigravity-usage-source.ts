import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { ANTIGRAVITY_PROVIDER_ID } from "./antigravity-provider";
import { createHostUsageSource } from "./host-usage-source";
import type { SourceUsage, UsageSource } from "./usage-source-contract";

export const ANTIGRAVITY_RESOURCE_PREFIX = "antigravity:";

export function createAntigravityUsageSource(
  bb: Pick<BbPluginApi, "sdk">,
  readHostUsage: (hostId: string) => Promise<SourceUsage>,
  now: () => number = Date.now,
): UsageSource {
  return createHostUsageSource(
    bb,
    {
      providerId: ANTIGRAVITY_PROVIDER_ID,
      resourcePrefix: ANTIGRAVITY_RESOURCE_PREFIX,
      label: "Google Antigravity (usage)",
      failureMessage: "Google Antigravity usage could not be read.",
      read: readHostUsage,
    },
    now,
  );
}
