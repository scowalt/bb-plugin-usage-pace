import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { bankedResetsSchema, resetProviderSchema } from "./banked-resets-contract";
import { sourceUsageSchema } from "./usage-source-contract";

export const bankedResetsHostContract = defineRpcContract({
  readBankedResets: {
    input: z.object({ force: z.boolean().optional(), providerId: resetProviderSchema.optional() }).strict(),
    output: bankedResetsSchema,
  },
  readUsage: {
    input: z.object({ providerId: resetProviderSchema }).strict(),
    output: z.object({ accountKey: z.string().min(1).nullable(), usage: sourceUsageSchema }),
  },
});
