import { z } from "zod";

export const resetProviderSchema = z.enum(["codex", "claude-code"]);
export type ResetProviderId = z.infer<typeof resetProviderSchema>;
export const supportsBankedResets = (id: string): id is ResetProviderId => id === "codex" || id === "claude-code";
export const resetProviderName = (id: string) => id === "claude-code" ? "Claude" : "Codex";

export const sessionResetSchema = z.object({
  availability: z.enum(["available", "unavailable", "unknown"]),
  reason: z.string().nullable(),
  nextAvailableAt: z.string().nullable(),
});
export type SessionReset = z.infer<typeof sessionResetSchema>;

export const bankedResetsSchema = z.object({
  status: z.enum(["ok", "unauthenticated", "unsupported", "error"]),
  accountEmail: z.string().nullable(),
  fetchedAt: z.string().nullable(),
  availableCount: z.number().int().nonnegative().nullable(),
  credits: z.array(z.object({
    id: z.string(),
    title: z.string(),
    expiresAt: z.string().nullable(),
    supported: z.boolean().nullable(),
    remaining: z.number().int().positive().optional(),
    scope: z.enum(["full", "five-hour", "other"]).optional(),
    clears: z.array(z.string()).optional(),
    usableNow: z.boolean().nullable().optional(),
  })),
  sessionReset: sessionResetSchema.optional(),
  message: z.string().nullable(),
});
export type BankedResets = z.infer<typeof bankedResetsSchema>;

export function bankedResetsUnavailable(
  message: string,
  status: Exclude<BankedResets["status"], "ok"> = "error",
  accountEmail: string | null = null,
): BankedResets {
  return { status, accountEmail, fetchedAt: null, availableCount: null, credits: [], message };
}
