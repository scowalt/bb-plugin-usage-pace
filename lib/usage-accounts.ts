import { z } from "zod";

export const windowKindSchema = z.enum(["five-hour", "daily", "weekly", "custom"]);
export const planSchema = z.object({ id: z.string().min(1), multiplier: z.number().positive().nullable() }).nullable();
export const usageWindowSchema = z.object({
  id: z.string().optional(),
  label: z.string(),
  usedPercent: z.number().finite().nonnegative(),
  resetsAt: z.string().nullable(),
  weekly: z.boolean(),
  kind: windowKindSchema.optional(),
  model: z.string().nullable().optional(),
});
export type UsageWindow = z.infer<typeof usageWindowSchema>;

export const scopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("shared") }),
  z.object({ kind: z.literal("host"), hostId: z.string().min(1), hostName: z.string().min(1) }),
]);
export const sourceSchema = z.object({
  pluginId: z.string(), label: z.string(), resourceId: z.string(), scope: scopeSchema,
});
export const accountSchema = z.object({
  id: z.string(), displayName: z.string(),
  hostId: z.string(), hostName: z.string(),
  logoUrl: z.string().nullable(),
  icon: z.object({ glyph: z.string() }).nullable(),
  iconTint: z.object({ light: z.string(), dark: z.string() }).nullable(),
  status: z.enum(["ok", "not_installed", "unauthenticated", "expired", "error"]),
  message: z.string().nullable(),
  accountEmail: z.string().nullable(), planLabel: z.string().nullable(),
  windows: z.array(usageWindowSchema),
  accountKey: z.string().nullable(),
  sources: z.array(sourceSchema),
  hosts: z.array(z.object({ id: z.string(), name: z.string() })),
  observedAt: z.number().finite().nonnegative().nullable(),
  plan: planSchema,
  accountLabel: z.string(),
  weight: z.number().positive().nullable(),
  stale: z.boolean(),
});
export type UsageAccount = z.infer<typeof accountSchema>;
export type UsageProvider = UsageAccount;

export const isWeeklyLabel = (label: string) => /(week|7\s*[-‑]?\s*day|7d\b|weekly)/iu.test(label);
export const isWeeklyWindow = (window: Pick<UsageWindow, "label" | "kind">) =>
  window.kind === undefined ? isWeeklyLabel(window.label) : window.kind === "weekly";

export function accountId(account: UsageAccount): string {
  return JSON.stringify([account.id, account.accountKey ?? account.sources.map(source => [source.pluginId, source.resourceId])]);
}

export function mergeAccounts(accounts: UsageAccount[]): UsageAccount[] {
  const merged: UsageAccount[] = [];
  const known = new Map<string, number>();
  for (const account of accounts) {
    const key = account.accountKey === null ? null : JSON.stringify([account.id, account.accountKey]);
    const index = key === null ? undefined : known.get(key);
    if (index === undefined) {
      if (key !== null) known.set(key, merged.length);
      merged.push(account);
      continue;
    }
    const prior = merged[index]!;
    const freshest = (account.observedAt ?? -1) > (prior.observedAt ?? -1) ||
      (account.observedAt === prior.observedAt && prior.stale && !account.stale) ? account : prior;
    const sources = [...prior.sources, ...account.sources].filter((source, i, all) =>
      all.findIndex(other => other.pluginId === source.pluginId && other.resourceId === source.resourceId) === i);
    const hosts = [...prior.hosts, ...account.hosts].filter((host, i, all) => all.findIndex(other => other.id === host.id) === i);
    const errors = [...new Set([prior.message, account.message].filter(Boolean))].join("; ");
    merged[index] = { ...freshest, sources, hosts, message: errors || null };
  }
  return merged.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.accountLabel.localeCompare(b.accountLabel));
}

export function parsePairs(value: string): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const part of value.split(/[,\n]/u)) {
    const at = part.indexOf("=");
    if (at < 1) continue;
    const key = part.slice(0, at).trim().toLowerCase();
    const entry = part.slice(at + 1).trim();
    if (key && entry) pairs.set(key, entry);
  }
  return pairs;
}

export function withAccountSettings(account: UsageAccount, aliases: Map<string, string>, weights: Map<string, string>): UsageAccount {
  const email = account.accountEmail;
  const key = email?.toLowerCase() ?? "";
  const override = Number(weights.get(key));
  const multiplier = account.plan?.multiplier ?? (account.plan?.id.toLowerCase() === "pro" ? 1 : null);
  return {
    ...account,
    accountLabel: aliases.get(key) ?? email?.split("@")[0] ?? account.accountLabel,
    weight: Number.isFinite(override) && override > 0 ? override : multiplier,
  };
}

export const hasSharedSource = (account: UsageAccount) => account.sources.some(source => source.scope.kind === "shared");
export const onHost = (account: UsageAccount, hostId: string) => account.hosts.some(host => host.id === hostId);
export function observationTime(account: UsageAccount, fetchedAt: string, now: number): number {
  const time = account.observedAt ?? Date.parse(fetchedAt);
  return Number.isFinite(time) ? Math.min(time, now) : now;
}
export function usageIsStale(account: UsageAccount, now: number): boolean {
  return account.stale || account.observedAt === null || account.windows.some(window => window.resetsAt !== null && Date.parse(window.resetsAt) <= now);
}
