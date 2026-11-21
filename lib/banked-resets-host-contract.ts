import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { bankedResetsSchema, resetProviderSchema } from "./banked-resets-contract";
import { ANTIGRAVITY_PROVIDER_ID } from "./antigravity-provider";
import { sourceUsageSchema } from "./usage-source-contract";

const usageProviderSchema = z.union([resetProviderSchema, z.literal(ANTIGRAVITY_PROVIDER_ID)]);
export type UsageProviderId = z.infer<typeof usageProviderSchema>;

export const bankedResetsHostContract = defineRpcContract({
  readBankedResets: {
    input: z.object({ force: z.boolean().optional(), providerId: resetProviderSchema.optional() }).strict(),
    output: bankedResetsSchema,
  },
  readUsage: {
    input: z.object({ providerId: usageProviderSchema }).strict(),
    output: z.object({ accountKey: z.string().min(1).nullable(), usage: sourceUsageSchema }),
  },
});
