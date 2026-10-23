import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { accountSchema, isWeeklyWindow, mergeAccounts, planSchema, scopeSchema, windowKindSchema, type UsageAccount } from "./usage-accounts";

export const sourceListSchema = z.object({
  label: z.string().optional(),
  resources: z.array(z.object({
    id: z.string().min(1), providerId: z.string().min(1), label: z.string(),
    accountKey: z.string().nullable().default(null), scope: scopeSchema,
  })),
});
const accountFields = { plan: planSchema, accountEmail: z.string().nullable(), planLabel: z.string().nullable() };
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
export type CollectedUsage = { accounts: UsageAccount[]; error: string | null; hostsError: string | null };

const names: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", "usage-pace-grok": "Grok Build (usage)" };
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

export function createUsageCollector(bb: Pick<BbPluginApi, "sdk">, signal: AbortSignal, now: () => number = Date.now) {
  let discovery: { at: number; sources: Source[] } | null = null;
  const previous = new Map<string, Map<string, UsageAccount>>();

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
    for (const id of previous.keys()) if (!active.has(id)) previous.delete(id);
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
          let account: UsageAccount;
          try {
            const measurement = await rpc(source, "provider-usage.v1.getResource", { resourceId: resource.id, refresh: force }, measurementSchema);
            const usage = measurement.usage;
            if (usage.status === "error") {
              const message = `${source.displayName}: ${usage.message}`;
              const prior = old.get(resource.id);
              const accountKey = measurement.accountKey ?? prior?.accountKey ?? null;
              const sameAccount = accountKey !== null && prior?.accountKey === accountKey;
              account = { ...(sameAccount ? prior : base), stale: true, message,
                accountKey, observedAt: measurement.observedAt,
                accountEmail: usage.accountEmail, plan: usage.plan, planLabel: usage.planLabel };
            } else account = { ...base, accountKey: measurement.accountKey, observedAt: measurement.observedAt,
              status: usage.status, plan: usage.plan, accountEmail: usage.accountEmail, planLabel: usage.planLabel,
              windows: usage.status === "ok" ? usage.windows.map(window => ({ ...window, weekly: isWeeklyWindow(window) })) : [],
              stale: usage.status === "ok" && measurement.observedAt === null,
            };
          } catch (error) {
            const message = `${source.displayName}: ${messageOf(error)}`;
            account = failed(old.get(resource.id) ?? base, message);
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
