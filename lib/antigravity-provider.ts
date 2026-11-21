import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { AcpLaunchSpec } from "@get-bb/plugin-sdk/provider-bridge/acp";

export const ANTIGRAVITY_PROVIDER_ID = "usage-pace-antigravity";

export const ANTIGRAVITY_LAUNCH_SPEC = {
  displayName: "Google Antigravity",
  command: "agy",
  args: ["acp"],
  env: {},
} satisfies AcpLaunchSpec;

export function registerAntigravityProvider(bb: BbPluginApi) {
  bb.providers.register({
    id: ANTIGRAVITY_PROVIDER_ID,
    displayName: "Google Antigravity (usage)",
    family: "acp",
    icon: "./assets/icons/antigravity.svg",
    experimental_bridgeOptions: {
      acpDialect: "acp",
      acpLaunchSpec: ANTIGRAVITY_LAUNCH_SPEC,
    },
    experimental_visibility: "installed",
    maintenance: {
      health: true,
      usage: true,
    },
    capabilities: {
      supportsServiceTier: true,
      supportsNativeUserQuestion: false,
      fork: "none",
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["accept-edits", "full"],
      reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    composerActions: [],
    strings: {
      signInHint: "Sign in to Google Antigravity on the machine, then reload.",
      expiredHint: "Your Google Antigravity session expired. Sign in on the machine, then reload.",
      installUrl: "https://agentclientprotocol.com",
    },
    serviceTiers: [
      { id: "default", label: "Default" },
      { id: "fast", label: "Fast" },
    ],
    models: { scope: "host" },
  });
}
