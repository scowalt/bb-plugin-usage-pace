import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { bankedResetsSchema } from "./banked-resets-contract";

export const bankedResetsHostContract = defineRpcContract({
  readBankedResets: {
    input: z.object({ force: z.boolean().optional() }).strict(),
    output: bankedResetsSchema,
  },
});
