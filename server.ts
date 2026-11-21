import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ANTIGRAVITY_PROVIDER_ID, registerAntigravityProvider } from "./lib/antigravity-provider";
import { createAntigravityUsageSource } from "./lib/antigravity-usage-source";
import { DEFAULT_BANDS_TEXT, parseEffortBands, type EffortBands, type UsageReading } from "./lib/autopilot";
import { createAutopilot } from "./lib/autopilot-shell";
import { hasNewThreadSeam, registerNewThreadChooser } from "./lib/new-thread-seam";
import { registerGrokProvider } from "./lib/grok-provider";
import { createGrokUsageSource } from "./lib/grok-usage-source";
import { createSubscriptionUsageSource } from "./lib/subscription-usage-source";
import { combineUsageSources, usageSourceContract, type UsageSource } from "./lib/usage-source-contract";
import { describePace, paceForWindows } from "./lib/pace";
import { createTokenTotals } from "./lib/token-totals";
import { bankedResetsSchema, bankedResetsUnavailable, resetProviderSchema, type BankedResets, type ResetProviderId } from "./lib/banked-resets-contract";
import { bankedResetsHostContract } from "./lib/banked-resets-host-contract";

import { accountLocation, accountSchema, distinctAccountLabel, lastReadDescription, observationTime, parsePairs, staleUsageReason, usageIsStale, withAccountSettings, type UsageAccount } from "./lib/usage-accounts";
import { createUsageCollector } from "./lib/usage-collector";
import { accountWithPace, usageCliSchema } from "./lib/usage-cli";
import { describePool, poolSchema, usagePools } from "./lib/usage-pools";
export { isWeeklyLabel } from "./lib/usage-accounts";
export type { UsageAccount, UsageProvider, UsageWindow } from "./lib/usage-accounts";

const snapshotSchema = z.object({
  accounts: z.array(accountSchema).optional(),
  providers: z.array(accountSchema),
  pools: z.array(poolSchema).optional(),
  fetchedAt: z.string(),
  error: z.string().nullable(),
  showStrip: z.boolean().optional(),
  serverOnly: z.boolean().optional(),
  serverHostId: z.string().nullable().optional(),
  serverHostError: z.string().nullable().optional(),
});
export type UsageSnapshot = z.infer<typeof snapshotSchema>;

export const rpcContract = defineRpcContract({
  getBankedResets: {
    input: z.object({ hostId: z.string().min(1).max(128), force: z.boolean().optional(), providerId: resetProviderSchema.optional() }).strict(),
    output: bankedResetsSchema,
  },
  getTokens: {
    input: z.object({ timeZone: z.string().max(100), force: z.boolean().optional() }),
    output: z.object({ day: z.number(), month: z.number(), timeZone: z.string(), fetchedAt: z.string().nullable(), error: z.string().nullable() }),
  },
  getUsage: {
    input: z.object({ force: z.boolean().optional() }).nullable(),
    output: snapshotSchema,
  },
  getCardSettings: {
    input: z.object({}).nullable(),
    output: z.object({ hiddenProviders: z.array(z.string()) }),
  },
});

export function parseProviderList(value: string): string[] {
  return value
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== "");
}

export default async function plugin(bb: BbPluginApi) {
  const getTokens = createTokenTotals(bb);
  const hostEntry = bb.hosts.experimental_client({ contract: bankedResetsHostContract });
  const bankedController = new AbortController();
  bb.onDispose(() => bankedController.abort());
  async function getBankedResets(hostId: string, force = false, providerId: ResetProviderId = "codex"): Promise<BankedResets> {
    try {
      const host = (await bb.sdk.hosts.list()).find(host => host.id === hostId);
      if (!host || host.status === "disconnected") return bankedResetsUnavailable("Host is offline or no longer available. Reconnect it, then refresh.");
      return await hostEntry.call("readBankedResets", { force, providerId }, { hostId, signal: bankedController.signal });
    } catch {
      return bankedResetsUnavailable("Could not read banked resets from this host. Reconnect it, then refresh.");
    }
  }
  const settings = bb.settings.define({
    cacheMinutes: {
      type: "number",
      label: "Cache usage for (minutes)",
      default: 5,
    },
    showStrip: {
      type: "boolean",
      label: "Also show the Usage Pace strip in a sidebar footer card",
      description: "Reload the app UI after changing this. Opens at startup; another footer card closes it. Use the Usage Pace footer icon to reopen it.",
      default: false,
    },
    accountAliases: {
      type: "string", label: "Account aliases",
      description: "email=Alias pairs, separated by commas or newlines.", default: "",
    },
    poolWeights: {
      type: "string", label: "Pool weight overrides",
      description: "email=positive weight pairs. Defaults to the plan's weekly limit as a multiple of Pro (Claude Max 5, Ultra 10); weekly pool numbers are estimates.", default: "",
    },
    serverOnly: {
      type: "boolean",
      label: "Only show providers on the server machine",
      description: "Keeps server-local and shared-source accounts in the strip and dialog. Reset reads stay on the server. Shared across browsers; the Provider Usage card, CLI, and token totals stay global.",
      default: false,
    },
    hiddenCardProviders: {
      type: "string",
      label: "Hide these providers in bb's usage card",
      description: "Provider names as the card shows them, separated by commas. For example: Cursor",
      default: "",
    },
    grokUsage: {
      type: "boolean",
      label: "Add Grok Build usage to bb's usage card (takes effect after a plugin reload)",
      default: true,
    },
    antigravityUsage: {
      type: "boolean",
      label: "Add Google Antigravity usage to bb's usage card (takes effect after a plugin reload)",
      default: true,
    },
    autopilot: {
      type: "boolean",
      label: "Choose each new thread's model and effort",
      description: "Picks Opus or Gemini Neon from subscription pace, and sets the effort from overall pace. Applies to threads that name no model. Needs a bb with the new-thread chooser.",
      default: true,
    },
    autopilotEffortBands: {
      type: "string",
      label: "Autopilot effort bands",
      description: "Overall pace below each number gets that level; the last entry covers the rest. Levels: low, medium, high, xhigh, max. A level the model lacks drops to the nearest lower one.",
      default: DEFAULT_BANDS_TEXT,
    },
  });
  let cacheMs = 5 * 60_000;
  let showStrip = false;
  let serverOnly = false;
  let hiddenProviders: string[] = [];
  let autopilotEnabled = true;
  let autopilotBands: EffortBands = parseEffortBands("").bands;
  let autopilotRegistered = false;
  let aliases = new Map<string, string>();
  let weights = new Map<string, string>();
  const applySettings = async () => {
    const values = await settings.get();
    cacheMs = Math.max(0.5, Number(values.cacheMinutes) || 5) * 60_000;
    showStrip = values.showStrip === true;
    serverOnly = values.serverOnly === true;
    hiddenProviders = parseProviderList(String(values.hiddenCardProviders ?? ""));
    aliases = parsePairs(String(values.accountAliases ?? ""));
    weights = parsePairs(String(values.poolWeights ?? ""));
    autopilotEnabled = values.autopilot !== false;
    const bands = parseEffortBands(String(values.autopilotEffortBands ?? ""));
    autopilotBands = bands.bands;
    if (bands.warning !== null) bb.log.warn(bands.warning);
  };
  await applySettings();
  const usageSources: UsageSource[] = [createSubscriptionUsageSource(bb, (hostId, providerId) =>
    hostEntry.call("readUsage", { providerId }, { hostId, signal: bankedController.signal }))];
  const providerSettings = await settings.get();
  if (providerSettings.grokUsage !== false) {
    registerGrokProvider(bb);
    usageSources.push(createGrokUsageSource(bb));
  }
  if (providerSettings.antigravityUsage !== false) {
    registerAntigravityProvider(bb);
    usageSources.push(createAntigravityUsageSource(bb, async (hostId) =>
      (await hostEntry.call("readUsage", { providerId: ANTIGRAVITY_PROVIDER_ID }, { hostId, signal: bankedController.signal })).usage));
  }
  bb.rpc.register(usageSourceContract, combineUsageSources(usageSources), {
    experimental_discoverable: true,
    experimental_description:
      "Usage from Usage Pace: Grok Build and Google Antigravity, plus Claude Code and Codex on machines where bb's own provider is disabled. Inventory reads metadata only.",
  });
  settings.onChange?.(async () => {
    await applySettings();
    registerAutopilot();
    bb.realtime.publish("usage-changed", { fetchedAt: new Date().toISOString() });
  });

  type LoadedUsage = {
    snapshot: UsageSnapshot;
    hostsError: string | null;
  };
  let cached: { at: number; usage: LoadedUsage; dirty: boolean } | null = null;
  let pending: Promise<LoadedUsage> | null = null;

  const collect = createUsageCollector(bb, bankedController.signal, Date.now, () => cacheMs);
  async function loadSnapshot(force: boolean): Promise<LoadedUsage> {
    const { accounts, error, hostsError } = await collect(force);
    return { snapshot: { accounts, providers: accounts, fetchedAt: new Date().toISOString(), error }, hostsError };
  }
  function configuredSnapshot(snapshot: UsageSnapshot): UsageSnapshot {
    const accounts = (snapshot.accounts ?? snapshot.providers).map(account => withAccountSettings({ ...account, stale: usageIsStale(account, Date.now()) }, aliases, weights));
    return { ...snapshot, accounts, providers: accounts, pools: usagePools(accounts, snapshot.fetchedAt) };
  }

  async function getUsage(force: boolean): Promise<LoadedUsage> {
    const maxAge = cached?.dirty ? Math.min(cacheMs, 60_000) : cacheMs;
    if (!force && cached !== null && Date.now() - cached.at < maxAge) {
      return cached.usage;
    }
    if (pending !== null) return pending;
    pending = loadSnapshot(force)
      .then((usage) => {
        if (!bankedController.signal.aborted) {
          cached = { at: Date.now(), usage, dirty: false };
          bb.realtime.publish("usage-changed", { fetchedAt: usage.snapshot.fetchedAt });
        }
        return usage;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  }

  async function readUsageForAutopilot(): Promise<UsageReading | null> {
    const loading = getUsage(false);
    const soon = await Promise.race([loading, new Promise<null>(resolve => setTimeout(resolve, 50, null))]);
    const loaded = soon ?? cached?.usage ?? await loading;
    const snapshot = configuredSnapshot(loaded.snapshot);
    return { accounts: snapshot.accounts ?? snapshot.providers, fetchedAt: snapshot.fetchedAt };
  }

  const autopilot = createAutopilot({
    bb,
    signal: bankedController.signal,
    settings: () => ({ enabled: autopilotEnabled, bands: autopilotBands }),
    readUsage: readUsageForAutopilot,
  });

  function registerAutopilot() {
    if (autopilotRegistered || !autopilotEnabled) return;
    if (!hasNewThreadSeam(bb)) {
      bb.log.info("Autopilot is on, but this bb has no new-thread chooser yet, so it chooses nothing.");
      return;
    }
    try {
      registerNewThreadChooser(bb, request => autopilot.choose(request));
      autopilotRegistered = true;
      autopilot.warm();
    } catch (error) {
      bb.log.warn(`Autopilot could not register its chooser: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  registerAutopilot();

  async function autopilotCli(args: string[]) {
    const usage = "Usage: bb usage-pace autopilot [--json] [--host <id>]";
    let json = false;
    let hostId: string | null = null;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!;
      if (arg === "--json") json = true;
      else if (arg === "--host" || arg.startsWith("--host=")) {
        hostId = arg === "--host" ? (args[++index] ?? "") : arg.slice("--host=".length);
        if (hostId === "" || hostId.startsWith("--")) return { exitCode: 1, stderr: `--host needs a machine id.\n${usage}` };
      } else return { exitCode: 1, stderr: usage };
    }
    const choice = await autopilot.choose({ origin: "cli", hostId, requested: { providerId: null, model: null, reasoningLevel: null }, sources: { providerId: null, model: null, reasoningLevel: null } });
    if (json) return { exitCode: 0, stdout: JSON.stringify({ enabled: autopilotEnabled, active: autopilotRegistered, hostId, choice }) };
    if (choice === null) return { exitCode: 0, stdout: "Autopilot is off. New threads get the model they name, or bb's usual default." };
    return {
      exitCode: 0,
      stdout: [
        `New threads get ${choice.providerId} · ${choice.model} at effort ${choice.reasoningLevel}.`,
        `Why: ${choice.reason}`,
        ...(autopilotRegistered ? [] : ["Not active: this bb has no new-thread chooser yet, so nothing uses this choice."]),
      ].join("\n"),
    };
  }

  async function getServerScope(usage: LoadedUsage) {
    let serverHostId: string | null = null;
    let serverHostError: string | null = null;
    try {
      serverHostId = (await bb.sdk.system.config()).primaryHostId;
      if (serverHostId === null) {
        serverHostError = "Server host is not available. Check bb's machine connection, then refresh.";
      } else {
        const host = (await bb.sdk.hosts.list()).find(host => host.id === serverHostId);
        serverHostError = !host
          ? "Server host is no longer available. Check bb's machine connection, then refresh."
          : host.status === "disconnected"
            ? "Server host is offline. Reconnect it, then refresh usage."
            : usage.hostsError;
      }
    } catch {
      serverHostError = "Could not identify the server host. Check bb's machine connection, then refresh.";
    }
    return { serverHostId, serverHostError };
  }

  const markDirty = () => {
    if (cached !== null) cached.dirty = true;
  };
  bb.events.on("thread.idle", markDirty);
  bb.events.on("thread.failed", markDirty);

  bb.rpc.register(rpcContract, {
    getBankedResets: (input) => getBankedResets(input.hostId, input.force, input.providerId),
    getTokens: (input) => getTokens(input.timeZone, input.force),
    getCardSettings: () => ({ hiddenProviders }),
    getUsage: async (input) => {
      const usage = await getUsage(input?.force === true);
      const scope = await getServerScope(usage);
      return { ...configuredSnapshot(usage.snapshot), ...scope, showStrip, serverOnly };
    },
  });

  function formatReset(resetsAt: string | null): string {
    if (resetsAt === null) return "";
    const ms = new Date(resetsAt).getTime() - Date.now();
    if (!Number.isFinite(ms) || ms <= 0) return "resets now";
    const hours = Math.floor(ms / 3_600_000);
    const days = Math.floor(hours / 24);
    const rest = hours % 24;
    const minutes = Math.floor((ms % 3_600_000) / 60_000);
    if (days > 0) return `resets in ${days}d ${rest}h`;
    if (hours > 0) return `resets in ${hours}h ${minutes}m`;
    return `resets in ${minutes}m`;
  }

  function formatSnapshot(snapshot: UsageSnapshot, weeklyOnly: boolean): string {
    const lines: string[] = [];
    const groups = new Map<string, UsageAccount[]>();
    for (const account of snapshot.accounts ?? snapshot.providers) {
      const group = groups.get(account.id) ?? [];
      group.push(account); groups.set(account.id, group);
    }
    for (const [providerId, accounts] of groups) {
      const pool = snapshot.pools?.find(pool => pool.providerId === providerId);
      if (pool) lines.push(`${accounts[0]!.displayName} ∑ ${describePool(pool)}`);
      for (const provider of accounts) {
        const heading = [provider.displayName, distinctAccountLabel(provider)].filter(Boolean).join(" · ");
        const location = accountLocation(provider);
        if (provider.status !== "ok") {
          lines.push(`${heading} (${location}): ${provider.status}${provider.message ? ` — ${provider.message}` : ""}`);
          if (provider.stale || provider.windows.length > 0) lines.push(`  usage unknown · ${lastReadDescription(provider)}`);
          continue;
        }
        const stale = usageIsStale(provider, Date.now());
        const paces = stale ? provider.windows.map(() => null)
          : paceForWindows(provider.windows, observationTime(provider, snapshot.fetchedAt, Date.now()));
        const shown = provider.windows
          .map((window, index) => ({ window, pace: paces[index]! }))
          .filter(({ window }) => !weeklyOnly || window.weekly);
        if (shown.length === 0) continue;
        lines.push(
          `${heading}${provider.planLabel ? ` · ${provider.planLabel}` : ""} (${location})`,
          `  via ${[...new Set(provider.sources.map(source => source.label))].join(", ")} · observed ${provider.observedAt === null ? "unknown" : new Date(provider.observedAt).toISOString()}`,
          ...(stale ? [`  stale: usage unknown · ${lastReadDescription(provider)}. ${staleUsageReason(provider)}`] : []),
        );
        for (const { window, pace } of shown) {
          lines.push(`  ${window.label.padEnd(18)} ${stale ? "unknown" : `${String(Math.round(window.usedPercent)).padStart(3)}%`}  ${formatReset(window.resetsAt)}`);
          const paceText = describePace(pace);
          if (paceText) lines.push(`  ${"".padEnd(18)} ${paceText}`);
        }
      }
    }
    if (snapshot.error) lines.push(`warning: ${snapshot.error}`);
    return lines.length === 0 ? "No usage available." : lines.join("\n");
  }

  const usageText = [
    "Usage:",
    "  bb usage-pace [--all] [--force] [--json]",
    "  bb usage-pace autopilot [--json] [--host <id>]",
    "",
    "  --resets read-only Codex banked resets (primary host; --json for details)",
    "  --tokens total tokens across BB for today and this month (JSON)",
    "  --all    show every window, not only weekly ones",
    "  --force  bypass the cache and query providers now",
    "  --json   accounts, pools, and per-window pace; providers is a deprecated accounts alias",
    "",
    "  autopilot  the model and effort a new thread would get now, and why",
  ].join("\n");

  bb.cli.register({
    name: "usage-pace",
    summary: "Show agent-provider usage limits and pace (weekly windows by default)",
    commands: [
      {
        name: "show",
        summary: "Print usage windows with pace",
        usage: "bb usage-pace [show] [--all] [--force] [--json]",
      },
      {
        name: "autopilot",
        summary: "Print the model and effort a new thread would get now, and why",
        usage: "bb usage-pace autopilot [--json] [--host <id>]",
      },
    ],
    async run(argv) {
      if (argv[0] === "autopilot") return autopilotCli(argv.slice(1));
      if (argv.includes("--resets")) {
        const hostId = (await bb.sdk.system.config()).primaryHostId;
        const snapshot = hostId ? await getBankedResets(hostId, argv.includes("--force")) : bankedResetsUnavailable("No primary host is configured.");
        const lines = snapshot.status === "ok" ? [
          `Codex banked resets: ${snapshot.availableCount} banked (not necessarily redeemable now)`,
          ...snapshot.credits.slice(0, 100).map(credit => `  ${credit.title} — ${credit.expiresAt ? `expires ${credit.expiresAt}` : "expiry not reported"}${credit.supported === false ? " (not supported by current plan)" : ""}`),
          ...(snapshot.message ? [snapshot.message] : []),
        ] : [snapshot.message ?? "Banked resets unavailable."];
        return { exitCode: snapshot.status === "ok" ? 0 : 1, stdout: argv.includes("--json") ? JSON.stringify({ hostId, ...snapshot, credits: snapshot.credits.slice(0, 100), truncated: snapshot.credits.length > 100 }) : lines.join("\n") };
      }
      if (argv.includes("--tokens")) {
        const snapshot = await getTokens(Intl.DateTimeFormat().resolvedOptions().timeZone, argv.includes("--force"));
        return { exitCode: snapshot.error ? 1 : 0, stdout: JSON.stringify(snapshot) };
      }
      const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
      const positional = argv.filter((arg) => !arg.startsWith("--"));
      if (positional[0] === "help" || flags.has("--help")) {
        return { exitCode: 0, stdout: usageText };
      }
      if (positional.length > 0 && positional[0] !== "show") {
        return { exitCode: 1, stderr: usageText };
      }
      const loaded = await getUsage(flags.has("--force"));
      const snapshot = configuredSnapshot(loaded.snapshot);
      if (flags.has("--json")) {
        const accounts = (snapshot.accounts ?? snapshot.providers).map(account => accountWithPace(account, snapshot.fetchedAt));
        return { exitCode: 0, stdout: JSON.stringify(usageCliSchema.parse({ ...snapshot, accounts, providers: accounts })) };
      }
      return {
        exitCode: 0,
        stdout: formatSnapshot(snapshot, !flags.has("--all")),
      };
    },
  });

  bb.onDispose(() => {
    cached = null;
  });
}
