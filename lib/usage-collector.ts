import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { accountSchema, isWeeklyWindow, mergeAccounts, planSchema, scopeSchema, usageIsStale, windowKindSchema, type UsageAccount } from "./usage-accounts";

export const sourceListSchema = z.object({
  label: z.string().optional(),
  resources: z.array(z.object({
    id: z.string().min(1), providerId: z.string().min(1), label: z.string(),
    accountKey: z.string().nullable().default(null), scope: scopeSchema,
  })),
});
const accountFields = { plan: planSchema, accountEmail: z.string().nullable(), planLabel: z.string().nullable(), message: z.string().nullable().optional() };
export const measurementSchema = z.object({
  accountKey: z.string().min(1).nullable().default(null),
  observedAt: z.number().int().nonnegative().nullable(),
  usage: z.discriminatedUnion("status", [
    z.object({ status: z.literal("ok"), ...accountFields, windows: z.array(z.object({
      id: z.string(), label: z.string(), kind: windowKindSchema.optional(), model: z.string().nullable().optional(),
      usedPercent: z.number().finite().nonnegative(), resetsAt: z.string().nullable(),
    })) }),
    z.object({ status: z.literal("not_installed"), ...accountFields }),
    z.object({ status: z.literal("unauthenticated"), ...accountFields }),
    z.object({ status: z.literal("expired"), ...accountFields }),
    z.object({ status: z.literal("error"), ...accountFields, message: z.string() }),
  ]),
});
type Resource = z.infer<typeof sourceListSchema>["resources"][number];
type Host = Awaited<ReturnType<BbPluginApi["sdk"]["hosts"]["list"]>>[number];
type Provider = Awaited<ReturnType<BbPluginApi["sdk"]["providers"]["list"]>>[number];
type Source = { pluginId: string; displayName: string };
type RefreshAttempt = { at: number; accountKey: string | null; message: string | null };
export type CollectedUsage = { accounts: UsageAccount[]; error: string | null; hostsError: string | null };

const names: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", "usage-pace-grok": "Grok Build (usage)" };
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

export function createUsageCollector(bb: Pick<BbPluginApi, "sdk">, signal: AbortSignal, now: () => number = Date.now, cachePeriod: () => number = () => 5 * 60_000) {
  let discovery: { at: number; sources: Source[] } | null = null;
  const previous = new Map<string, Map<string, UsageAccount>>();
  const refreshAttempts = new Map<string, Map<string, RefreshAttempt>>();

  async function bounded<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    let timer: ReturnType<typeof setTimeout>;
    let abort: () => void;
    const failure = new Promise<never>((_, reject) => {
      abort = () => reject(new Error("Usage read cancelled."));
      combined.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => { reject(new Error("Usage source timed out after 5 seconds.")); controller.abort(); }, 5000);
    });
    try {
      if (signal.aborted) throw new Error("Usage read cancelled.");
      return await Promise.race([work(combined), failure]);
    } finally {
      clearTimeout(timer!);
      combined.removeEventListener("abort", abort!);
      controller.abort();
    }
  }
  async function rpc<T>(source: Source, method: string, input: { resourceId: string; refresh: boolean } | Record<string, never>, outputSchema: z.ZodType<T>): Promise<T> {
    return outputSchema.parse(await bounded(signal => bb.sdk.plugins.callRpc({ pluginId: source.pluginId, method, input, outputSchema, signal })));
  }
  return async function collect(force: boolean): Promise<CollectedUsage> {
    let hostsError: string | null = null;
    const errors: string[] = [];
    let hosts: Host[] = [];
    try { hosts = await bounded(() => bb.sdk.hosts.list()); }
    catch (error) { hostsError = messageOf(error); errors.push(hostsError); }
    const metadata = new Map<string, Provider>();
    await Promise.all(hosts.filter(host => host.status !== "disconnected").map(async host => {
      try { for (const provider of await bounded(() => bb.sdk.providers.list({ hostId: host.id, capability: "usage" }))) metadata.set(provider.id, provider); }
      catch {}
    }));
    const rows: UsageAccount[] = [];
    const failed = (account: UsageAccount, message: string) => ({ ...account, stale: true, message });
    let sources: Source[];
    try {
      if (!discovery || now() - discovery.at >= 60_000) {
        const discovered = await bounded(() => bb.sdk.plugins.experimental_discoverRpc({ method: "provider-usage.v1.listResources" }));
        discovery = { at: now(), sources: [...new Map(discovered.map(source => [source.pluginId, source])).values()] };
      }
      sources = discovery.sources;
    } catch (error) {
      const message = `Usage source discovery: ${messageOf(error)}`;
      return { accounts: mergeAccounts([...previous.values()].flatMap(rows => [...rows.values()]
        .filter(account => !account.hosts.length || account.hosts.some(known => hosts.some(host => host.id === known.id && host.status !== "disconnected")))
        .map(account => failed(account, message)))), error: message, hostsError };
    }
    const active = new Set(sources.map(source => source.pluginId));
    for (const id of previous.keys()) if (!active.has(id)) { previous.delete(id); refreshAttempts.delete(id); }
    const tasks: (() => Promise<void>)[] = [];
    for (const source of sources) {
      let resources: Resource[];
      try { resources = (await rpc(source, "provider-usage.v1.listResources", {}, sourceListSchema)).resources; }
      catch (error) {
        const message = `${source.displayName}: ${messageOf(error)}`;
        errors.push(message);
        for (const account of previous.get(source.pluginId)?.values() ?? []) {
          if (account.hosts.length && !account.hosts.some(known => hosts.some(host => host.id === known.id && host.status !== "disconnected"))) continue;
          rows.push(failed(account, message));
        }
        continue;
      }
      const old = previous.get(source.pluginId) ?? new Map<string, UsageAccount>();
      const current = new Map<string, UsageAccount>();
      previous.set(source.pluginId, current);
      const attempts = refreshAttempts.get(source.pluginId) ?? new Map<string, RefreshAttempt>();
      refreshAttempts.set(source.pluginId, attempts);
      const resourceIds = new Set(resources.map(resource => resource.id));
      for (const id of attempts.keys()) if (!resourceIds.has(id)) attempts.delete(id);
      for (const resource of resources) {
        const scope = resource.scope;
        if (scope.kind === "host" && !hosts.some(host => host.id === scope.hostId && host.status !== "disconnected")) continue;
        tasks.push(async () => {
          const provider = metadata.get(resource.providerId);
          const base: UsageAccount = accountSchema.parse({
            id: resource.providerId, displayName: provider?.displayName ?? names[resource.providerId] ?? resource.providerId,
            hostId: scope.kind === "host" ? scope.hostId : "", hostName: scope.kind === "host" ? scope.hostName : source.displayName,
            logoUrl: provider?.logoUrl ?? null, icon: provider?.icon?.glyph ? { glyph: provider.icon.glyph } : null,
            iconTint: provider?.strings?.iconTint ?? null,
            status: "error", message: null, accountEmail: null, planLabel: null, windows: [],
            accountKey: null, observedAt: null, plan: null, accountLabel: resource.label, weight: null, stale: true,
            hosts: scope.kind === "host" ? [{ id: scope.hostId, name: scope.hostName }] : [],
            sources: [{ pluginId: source.pluginId, label: source.displayName, resourceId: resource.id, scope }],
          });
          const measured = (value: z.infer<typeof measurementSchema>): UsageAccount => ({
            ...base, accountKey: value.accountKey, observedAt: value.observedAt, status: value.usage.status,
            plan: value.usage.plan, accountEmail: value.usage.accountEmail, planLabel: value.usage.planLabel,
            windows: value.usage.status === "ok" ? value.usage.windows.map(window => ({ ...window, weekly: isWeeklyWindow(window) })) : [],
          });
          let prior = old.get(resource.id);
          let account: UsageAccount;
          try {
            const read = async (refresh: boolean, accountKey = prior?.accountKey ?? null) => {
              const at = now();
              if (refresh) attempts.set(resource.id, { at, accountKey, message: null });
              try {
                const value = await rpc(source, "provider-usage.v1.getResource", { resourceId: resource.id, refresh }, measurementSchema);
                if (refresh) attempts.set(resource.id, { at,
                  accountKey: value.accountKey ?? (value.usage.status === "ok" ? null : accountKey),
                  message: value.usage.status === "ok" ? value.usage.message ?? null
                    : `${value.usage.status}${value.usage.message ? ` — ${value.usage.message}` : ""}`,
                });
                return value;
              } catch (error) {
                if (refresh) attempts.set(resource.id, { at, accountKey, message: messageOf(error) });
                throw error;
              }
            };
            let measurement = await read(force);
            if (measurement.usage.status === "ok" && (measurement.accountKey !== prior?.accountKey ||
              (measurement.observedAt ?? -1) >= (prior?.observedAt ?? -1))) prior = measured(measurement);
            const attempt = attempts.get(resource.id);
            const period = cachePeriod();
            let refreshError: string | null = null;
            if (!force && measurement.usage.status === "ok" &&
              (measurement.observedAt === null || now() - measurement.observedAt >= period) &&
              (!attempt || attempt.accountKey !== measurement.accountKey || now() - attempt.at >= period)) {
              try { measurement = await read(true, measurement.accountKey); }
              catch (error) { refreshError = `${source.displayName}: ${messageOf(error)}`; }
            }
            const usage = measurement.usage;
            if (usage.status === "error" || usage.status === "expired" || usage.status === "unauthenticated") {
              const message = `${source.displayName}: ${usage.status === "error" ? usage.message : `${usage.status}${usage.message ? ` — ${usage.message}` : ""}`}`;
              const accountKey = measurement.accountKey ?? prior?.accountKey ?? null;
              const sameAccount = accountKey !== null && prior?.accountKey === accountKey;
              const retained = sameAccount && prior ? prior : base;
              account = { ...retained, status: usage.status === "error" ? retained.status : usage.status, stale: true, message,
                accountKey, observedAt: sameAccount ? retained.observedAt : measurement.observedAt,
                accountEmail: usage.accountEmail ?? retained.accountEmail,
                plan: usage.plan ?? retained.plan, planLabel: usage.planLabel ?? retained.planLabel };
            } else {
              const latestAttempt = attempts.get(resource.id);
              const refreshFailed = usage.status === "ok" && latestAttempt?.accountKey === measurement.accountKey &&
                (measurement.observedAt === null || latestAttempt.at - measurement.observedAt >= period);
              account = { ...measured(measurement),
                message: refreshError ?? (refreshFailed ? `${source.displayName} couldn't refresh this account. ${usage.message ?? latestAttempt.message ?? "The source returned an old or unavailable reading."}`
                  : usage.status === "ok" && usage.message ? `${source.displayName}: ${usage.message}` : null),
                stale: refreshFailed || refreshError !== null,
              };
              account.stale = usage.status === "ok" && usageIsStale(account, now());
            }
          } catch (error) {
            const message = `${source.displayName}: ${messageOf(error)}`;
            account = failed(prior ?? base, message);
          }
          current.set(resource.id, account);
          rows.push(account);
        });
      }
    }
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, tasks.length) }, async () => {
      while (next < tasks.length && !signal.aborted) await tasks[next++]!();
    }));
    return { accounts: mergeAccounts(rows), error: errors.length ? [...new Set(errors)].join("; ") : null, hostsError };
  };
}
