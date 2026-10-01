import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

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
  })),
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

export const bankedResetsHostContract = defineRpcContract({
  readBankedResets: {
    input: z.object({ force: z.boolean().optional() }).strict(),
    output: bankedResetsSchema,
  },
});
