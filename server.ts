import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { registerGrokProvider } from "./lib/grok-provider";
import { createGrokUsageSource, grokUsageSourceContract } from "./lib/grok-usage-source";
import { describePace, paceForWindows } from "./lib/pace";
import { createTokenTotals } from "./lib/token-totals";
import { bankedResetsSchema, bankedResetsUnavailable, resetProviderSchema, type BankedResets, type ResetProviderId } from "./lib/banked-resets-contract";
import { bankedResetsHostContract } from "./lib/banked-resets-host-contract";

import { accountSchema, observationTime, parsePairs, usageIsStale, withAccountSettings, type UsageAccount } from "./lib/usage-accounts";
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
  const bankedHost = bb.hosts.experimental_client({ contract: bankedResetsHostContract });
  const bankedController = new AbortController();
  bb.onDispose(() => bankedController.abort());
  async function getBankedResets(hostId: string, force = false, providerId: ResetProviderId = "codex"): Promise<BankedResets> {
    try {
      const host = (await bb.sdk.hosts.list()).find(host => host.id === hostId);
      if (!host || host.status === "disconnected") return bankedResetsUnavailable("Host is offline or no longer available. Reconnect it, then refresh.");
      return await bankedHost.call("readBankedResets", { force, providerId }, { hostId, signal: bankedController.signal });
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
      label: "Also show the Usage Pace strip above the sidebar footer",
      default: false,
    },
    accountAliases: {
      type: "string", label: "Account aliases",
      description: "email=Alias pairs, separated by commas or newlines.", default: "",
    },
    poolWeights: {
      type: "string", label: "Pool weight overrides",
      description: "email=positive weight pairs. Defaults to the plan multiplier; weekly pool numbers are estimates.", default: "",
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
  });
  let cacheMs = 5 * 60_000;
  let showStrip = false;
  let serverOnly = false;
  let hiddenProviders: string[] = [];
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
  };
  await applySettings();
  if ((await settings.get()).grokUsage !== false) {
    registerGrokProvider(bb);
    bb.rpc.register(grokUsageSourceContract, createGrokUsageSource(bb), {
      experimental_discoverable: true,
      experimental_description:
        "Grok Build usage from Usage Pace. Inventory reads metadata only.",
    });
  }
  settings.onChange?.(async () => {
    await applySettings();
    bb.realtime.publish("usage-changed", { fetchedAt: new Date().toISOString() });
  });

  type LoadedUsage = {
    snapshot: UsageSnapshot;
    hostErrors: Map<string, string>;
    hostsError: string | null;
  };
  let cached: { at: number; usage: LoadedUsage; dirty: boolean } | null = null;
  let pending: Promise<LoadedUsage> | null = null;

  const collect = createUsageCollector(bb, bankedController.signal);
  async function loadSnapshot(force: boolean): Promise<LoadedUsage> {
    const { accounts, error, hostErrors, hostsError } = await collect(force);
    return { snapshot: { accounts, providers: accounts, fetchedAt: new Date().toISOString(), error }, hostErrors, hostsError };
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
            : usage.hostErrors.get(serverHostId) ?? usage.hostsError;
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
        if (provider.status !== "ok") {
          lines.push(`${provider.displayName} · ${provider.accountLabel} (${provider.hostName}): ${provider.status}${provider.message ? ` — ${provider.message}` : ""}`);
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
          `${provider.displayName} · ${provider.accountLabel}${provider.planLabel ? ` · ${provider.planLabel}` : ""} (${provider.hosts.map(host => host.name).join(", ") || provider.hostName})`,
          `  via ${[...new Set(provider.sources.map(source => source.label))].join(", ")} · observed ${provider.observedAt === null ? "unknown" : new Date(provider.observedAt).toISOString()}`,
          ...(stale ? [`  stale: ${provider.message ?? "measurement unavailable or reset passed"}`] : []),
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
    "",
    "  --resets read-only Codex banked resets (primary host; --json for details)",
    "  --tokens total tokens across BB for today and this month (JSON)",
    "  --all    show every window, not only weekly ones",
    "  --force  bypass the cache and query providers now",
    "  --json   accounts, pools, and per-window pace; providers is a deprecated accounts alias",
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
    ],
    async run(argv) {
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
