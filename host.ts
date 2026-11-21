
import {
  createBridgeIo,
  experimental_defineProviderBridge,
  type ProviderBridgeEntry,
  type ProviderHealthResult,
  type ProviderUsageResult,
} from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_acpProviderBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";

import { ANTIGRAVITY_PROVIDER_ID } from "./lib/antigravity-provider";
import { readAgyUsage, readAntigravityHealth, readAntigravityUsage } from "./lib/antigravity-usage";
import { GROK_PROVIDER_ID } from "./lib/grok-provider";
import { readGrokHealth, readGrokUsage } from "./lib/grok-usage";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { bankedResetsHostContract, type UsageProviderId } from "./lib/banked-resets-host-contract";
import { createBankedResetsReader } from "./lib/banked-resets";
import { createClaudeLimitResetsReader } from "./lib/claude-limit-resets";
import { createClaudeUsageReader, createCodexUsageReader, type HostUsage } from "./lib/subscription-usage";

const readBankedResets = createBankedResetsReader();
const readClaudeLimitResets = createClaudeLimitResetsReader();
const readClaudeUsage = createClaudeUsageReader();
const readCodexUsage = createCodexUsageReader();
const USAGE_READERS: Record<UsageProviderId, (signal: AbortSignal) => Promise<HostUsage>> = {
  "claude-code": readClaudeUsage,
  codex: readCodexUsage,
  [ANTIGRAVITY_PROVIDER_ID]: async (signal) => ({ accountKey: null, usage: await readAgyUsage({ signal }) }),
};
export default experimental_defineHostEntry({
  contract: bankedResetsHostContract,
  handlers: {
    readBankedResets: (input, context) => input.providerId === "claude-code"
      ? readClaudeLimitResets(input.force, context.signal)
      : readBankedResets(input.force, context.signal),
    readUsage: (input, context) => USAGE_READERS[input.providerId](context.signal),
  },
});

const { sendResult, sendError } = createBridgeIo();
const MAINTENANCE_METHODS = new Set(["provider/health", "provider/usage"]);
const INVALID_PARAMS = -32602;

type MaintenanceReaders = {
  health: (providerOptions: unknown) => Promise<ProviderHealthResult>;
  usage: (providerOptions: unknown) => Promise<ProviderUsageResult>;
};

const MAINTENANCE_READERS = new Map<string, MaintenanceReaders>([
  [GROK_PROVIDER_ID, { health: readGrokHealth, usage: readGrokUsage }],
  [ANTIGRAVITY_PROVIDER_ID, { health: readAntigravityHealth, usage: readAntigravityUsage }],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function handleLine(line: string): void {
  const trimmed = line.trim();
  if (trimmed === "") return;

  let message: unknown;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (
    !isRecord(message) ||
    typeof message.method !== "string" ||
    !MAINTENANCE_METHODS.has(message.method) ||
    message.id === undefined
  ) {
    experimental_acpProviderBridge.handleLine(line);
    return;
  }

  void handleMaintenanceRequest(message).catch((error: unknown) => {
    sendError(
      message.id as string | number,
      -32603,
      error instanceof Error ? error.message : "Provider maintenance request failed",
    );
  });
}

async function handleMaintenanceRequest(message: Record<string, unknown>): Promise<void> {
  const id = message.id as string | number;
  const params = isRecord(message.params) ? message.params : {};
  const readers = typeof params.providerId === "string" ? MAINTENANCE_READERS.get(params.providerId) : undefined;
  if (readers === undefined) {
    sendError(id, INVALID_PARAMS, `No usage reader is registered for provider "${String(params.providerId)}".`);
    return;
  }
  const result = message.method === "provider/health"
    ? await readers.health(params.providerOptions)
    : await readers.usage(params.providerOptions);
  sendResult(id, result);
}

export const experimental_providerBridge: ProviderBridgeEntry = experimental_defineProviderBridge({
  handleLine,
  start: (context) => experimental_acpProviderBridge.start?.(context),
  onClose: () => experimental_acpProviderBridge.onClose?.(),
  onSigterm: () => experimental_acpProviderBridge.onSigterm?.(),
  onSigint: () => experimental_acpProviderBridge.onSigint?.(),
});
