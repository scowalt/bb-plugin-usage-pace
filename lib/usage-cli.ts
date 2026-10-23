import { z } from "zod";
import { accountSchema, observationTime, usageIsStale, usageWindowSchema, type UsageAccount } from "./usage-accounts";
import { paceForWindows } from "./pace";
import { poolSchema } from "./usage-pools";

const paceSchema = z.object({
  windowMs: z.number(), resetsAtMs: z.number(), elapsedFraction: z.number(), ratio: z.number().nullable(),
  projectedPercent: z.number().nullable(), runsOutAtMs: z.number().nullable(), lockoutMs: z.number(),
  budgetPerHour: z.number(), remainingMs: z.number(), leftPercent: z.number(), tone: z.enum(["ok", "warning", "critical"]),
}).nullable();
const cliAccountSchema = accountSchema.extend({ windows: z.array(usageWindowSchema.extend({ pace: paceSchema })) });
export const usageCliSchema = z.object({
  accounts: z.array(cliAccountSchema),
  providers: z.array(cliAccountSchema),
  pools: z.array(poolSchema), fetchedAt: z.string(), error: z.string().nullable(),
});

export function accountWithPace(account: UsageAccount, fetchedAt: string, now = Date.now()) {
  const paces = usageIsStale(account, now) ? account.windows.map(() => null)
    : paceForWindows(account.windows, observationTime(account, fetchedAt, now));
  return { ...account, windows: account.windows.map((window, index) => ({ ...window, pace: paces[index] ?? null })) };
}
