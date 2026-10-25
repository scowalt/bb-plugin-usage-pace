import { z } from "zod";
import { formatDuration, formatRatio, paceForWindows } from "./pace";
import { isWeeklyWindow, observationTime, usageIsStale, type UsageAccount } from "./usage-accounts";

export const poolSchema = z.object({
  providerId: z.string(), accounts: z.number().int().nonnegative(), available: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(), usedPercent: z.number().nullable(), pace: z.number().nullable(), partial: z.boolean(),
  exhausted: z.boolean(), resetsAt: z.number().nullable(),
  models: z.array(z.object({ model: z.string(), exhausted: z.number().int(), accounts: z.number().int() })),
});
export type UsagePool = z.infer<typeof poolSchema>;

export function displayedAccounts(accounts: UsageAccount[]): UsageAccount[] {
  return accounts.filter(account => account.status === "error" ||
    (["ok", "expired", "unauthenticated"].includes(account.status) && account.windows.length > 0));
}

export function usagePools(accounts: UsageAccount[], fetchedAt: string, now = Date.now()): UsagePool[] {
  const groups = new Map<string, UsageAccount[]>();
  for (const account of displayedAccounts(accounts)) {
    const group = groups.get(account.id) ?? [];
    group.push(account);
    groups.set(account.id, group);
  }
  const pools: UsagePool[] = [];
  for (const [providerId, group] of groups) {
    if (group.length < 2) continue;
    let available = 0, unknown = 0, exhaustedCount = 0;
    let used = 0, weight = 0, elapsed = 0, paceUsed = 0;
    let partial = false, paceUnknown = false;
    const resets: (number | null)[] = [];
    const models = new Map<string, Set<number>>();
    const modelAccounts = new Map<string, Set<number>>();
    for (const [index, account] of group.entries()) {
      const stale = account.status !== "ok" || usageIsStale(account, now) || account.windows.length === 0;
      const shared = account.windows.filter(window => window.model == null);
      const exhausted = shared.filter(window => window.usedPercent >= 100);
      if (stale || shared.length === 0) unknown++;
      else if (exhausted.length === 0) available++;
      else {
        exhaustedCount++;
        const times = exhausted.map(window => Date.parse(window.resetsAt ?? ""));
        resets.push(times.every(Number.isFinite) ? Math.max(...times) : null);
      }
      for (const window of account.windows) {
        if (window.model == null) continue;
        const all = modelAccounts.get(window.model) ?? new Set<number>();
        all.add(index); modelAccounts.set(window.model, all);
        const consumed = models.get(window.model) ?? new Set<number>();
        if (!stale && window.usedPercent >= 100) consumed.add(index);
        models.set(window.model, consumed);
      }
      const weekly = shared.find(isWeeklyWindow);
      const w = account.weight;
      if (stale || !weekly || w == null || !Number.isFinite(w) || w <= 0) { partial = true; continue; }
      used += w * weekly.usedPercent;
      weight += w;
      const pace = paceForWindows([weekly], observationTime(account, fetchedAt, now))[0];
      if (!pace) paceUnknown = true;
      else { elapsed += w * 100 * pace.elapsedFraction; paceUsed += w * weekly.usedPercent; }
    }
    const exhausted = exhaustedCount === group.length;
    const knownResets = resets.filter((reset): reset is number => reset !== null);
    pools.push({ providerId, accounts: group.length, available, unknown,
      usedPercent: weight > 0 ? used / weight : null,
      pace: !paceUnknown && elapsed > 0 ? paceUsed / elapsed : null, partial,
      exhausted, resetsAt: exhausted && knownResets.length ? Math.min(...knownResets) : null,
      models: [...modelAccounts.keys()].map(model => ({ model, accounts: group.length, exhausted: models.get(model)?.size ?? 0 })),
    });
  }
  return pools;
}

export function describePool(pool: UsagePool, now = Date.now()): string {
  const parts = [`${pool.available}/${pool.accounts} available`];
  if (pool.unknown) parts.push(`${pool.unknown} unknown`);
  if (pool.exhausted) parts.push(pool.resetsAt === null ? "reset unknown" : pool.resetsAt <= now ? "awaiting refresh" : `resets in ${formatDuration(pool.resetsAt - now)}`);
  else parts.push(`W ${pool.pace === null ? "unknown pace" : `${formatRatio(pool.pace)} pace`} · ${pool.usedPercent === null ? "usage unknown" : `${Math.round(pool.usedPercent)}% used`} (est.)`);
  if (pool.partial) parts.push("partial");
  for (const model of pool.models) if (model.exhausted) parts.push(`${model.model} ${model.exhausted}/${model.accounts} exhausted`);
  return parts.join(" · ");
}
