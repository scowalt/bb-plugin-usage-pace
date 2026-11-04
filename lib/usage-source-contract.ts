import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const planSchema = z
  .strictObject({ id: z.string().min(1), multiplier: z.number().int().positive().nullable() })
  .nullable();

export const sourceWindowSchema = z.strictObject({
  kind: z.enum(["five-hour", "daily", "weekly", "custom"]),
  id: z.string().min(1),
  label: z.string().min(1),
  usedPercent: z.number().min(0),
  resetsAt: z.string().nullable(),
  model: z.string().nullable(),
  cost: z
    .strictObject({ usedUsdCents: z.number().min(0), limitUsdCents: z.number().positive() })
    .nullable(),
});

const account = {
  plan: planSchema,
  accountEmail: z.string().nullable(),
  planLabel: z.string().nullable(),
};

export const sourceUsageSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ok"), ...account, windows: z.array(sourceWindowSchema) }),
  z.strictObject({ status: z.literal("not_installed"), ...account }),
  z.strictObject({ status: z.literal("unauthenticated"), ...account }),
  z.strictObject({ status: z.literal("expired"), ...account }),
  z.strictObject({ status: z.literal("error"), ...account, message: z.string() }),
]);

const resourceSchema = z.strictObject({
  accountKey: z.string().min(1).nullable(),
  id: z.string().min(1),
  providerId: z.string().min(1),
  label: z.string().min(1),
  scope: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("shared") }),
    z.strictObject({ kind: z.literal("host"), hostId: z.string().min(1), hostName: z.string().min(1) }),
  ]),
});

const getResourceOutput = z.strictObject({
  accountKey: z.string().min(1).nullable(),
  observedAt: z.number().int().min(0).nullable(),
  usage: sourceUsageSchema,
});

export type SourceUsage = z.infer<typeof sourceUsageSchema>;
export type SourceWindow = z.infer<typeof sourceWindowSchema>;
export type SourceResourceEntry = z.infer<typeof resourceSchema>;
export type SourceResource = z.infer<typeof getResourceOutput>;

export const usageSourceContract = defineRpcContract({
  "provider-usage.v1.listResources": {
    experimental_description:
      "Usage Pace's own usage resources, one per host and provider. Reads local metadata only.",
    input: z.object({}),
    output: z.strictObject({ resources: z.array(resourceSchema) }),
  },
  "provider-usage.v1.getResource": {
    experimental_description:
      "Usage for one listed resource. False permits a cached measurement.",
    input: z.object({ resourceId: z.string().min(1), refresh: z.boolean() }),
    output: getResourceOutput,
  },
});

export interface UsageSource {
  owns(resourceId: string): boolean;
  "provider-usage.v1.listResources"(): Promise<{ resources: SourceResourceEntry[] }>;
  "provider-usage.v1.getResource"(input: { resourceId: string; refresh: boolean }): Promise<SourceResource>;
}

export function combineUsageSources(sources: UsageSource[]) {
  return {
    "provider-usage.v1.listResources": async () => ({
      resources: (await Promise.all(sources.map(source => source["provider-usage.v1.listResources"]())))
        .flatMap(listed => listed.resources),
    }),
    "provider-usage.v1.getResource": (input: { resourceId: string; refresh: boolean }) => {
      const source = sources.find(candidate => candidate.owns(input.resourceId));
      if (source === undefined) throw new Error(`Unknown resource: ${input.resourceId}`);
      return source["provider-usage.v1.getResource"](input);
    },
  };
}
