import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { agyFixture } from "../tests/fake-agy";
import { ANTIGRAVITY_PROVIDER_ID } from "./antigravity-provider";
import { parseAgyUsage } from "./antigravity-usage";
import { createAntigravityUsageSource } from "./antigravity-usage-source";
import { createSubscriptionUsageSource } from "./subscription-usage-source";
import { combineUsageSources, usageSourceContract, type SourceUsage } from "./usage-source-contract";

const sampleUsage = parseAgyUsage(JSON.parse(agyFixture("agy-usage.json")));
const LIST = "provider-usage.v1.listResources";
const GET = "provider-usage.v1.getResource";

function fakeBb() {
  const bb = {
    sdk: {
      hosts: {
        list: vi.fn(async () => [
          { id: "host_a", name: "Beelink", status: "connected" },
          { id: "host_b", name: "Laptop", status: "connected" },
          { id: "host_c", name: "Old Mac", status: "disconnected" },
          { id: "host_d", name: "Unreachable", status: "connected" },
        ]),
      },
      providers: {
        list: vi.fn(async ({ hostId }: { hostId: string }) => {
          if (hostId === "host_d") throw new Error("unreachable");
          return hostId === "host_a" ? [{ id: "claude-code" }, { id: ANTIGRAVITY_PROVIDER_ID }] : [{ id: "claude-code" }];
        }),
      },
    },
  };
  return bb as never;
}

type Handlers = ReturnType<typeof createAntigravityUsageSource>;
function call(handlers: Handlers, method: typeof LIST, input: unknown): Promise<z.infer<typeof usageSourceContract[typeof LIST]["output"]>>;
function call(handlers: Handlers, method: typeof GET, input: unknown): Promise<z.infer<typeof usageSourceContract[typeof GET]["output"]>>;
async function call(handlers: Handlers, method: typeof LIST | typeof GET, input: unknown) {
  if (method === LIST) {
    usageSourceContract[LIST].input.parse(input);
    return usageSourceContract[LIST].output.parse(await handlers[LIST]());
  }
  const parsed = usageSourceContract[GET].input.parse(input);
  return usageSourceContract[GET].output.parse(await handlers[GET](parsed));
}

function setup(read: (hostId: string) => Promise<SourceUsage> = async () => sampleUsage, now: () => number = () => 1_000) {
  const readHostUsage = vi.fn(read);
  return { readHostUsage, handlers: createAntigravityUsageSource(fakeBb(), readHostUsage, now) };
}

const get = (handlers: Handlers, refresh = false, resourceId = "antigravity:host_a") =>
  call(handlers, GET, { resourceId, refresh });

describe("Antigravity usage source", () => {
  it("lists one resource per connected host where its provider is listed with usage", async () => {
    const { handlers, readHostUsage } = setup();
    expect((await call(handlers, LIST, {})).resources).toEqual([
      {
        accountKey: null,
        id: "antigravity:host_a",
        providerId: ANTIGRAVITY_PROVIDER_ID,
        label: "Google Antigravity (usage)",
        scope: { kind: "host", hostId: "host_a", hostName: "Beelink" },
      },
    ]);
    expect(readHostUsage).not.toHaveBeenCalled();
  });

  it("returns the host's read in the provider-usage.v1 shape", async () => {
    const { handlers, readHostUsage } = setup();
    const out = await get(handlers);
    expect(readHostUsage).toHaveBeenCalledWith("host_a");
    expect(out).toEqual({ accountKey: null, observedAt: 1_000, usage: sampleUsage });
    expect(out.usage.status === "ok" && out.usage.windows.map((window) => window.label)).toEqual([
      "Gemini Models · Weekly",
      "Gemini Models · 5h",
      "Claude and GPT models · Weekly",
      "Claude and GPT models · 5h",
      "Gemini 4 Argon · Weekly",
    ]);
  });

  it("answers from its cache for five minutes unless asked to refresh", async () => {
    let now = 0;
    const { handlers, readHostUsage } = setup(async () => sampleUsage, () => now);
    await get(handlers);
    now = 60_000;
    await get(handlers);
    expect(readHostUsage).toHaveBeenCalledTimes(1);
    await get(handlers, true);
    expect(readHostUsage).toHaveBeenCalledTimes(2);
    now = 60_000 + 5 * 60_000;
    await get(handlers);
    expect(readHostUsage).toHaveBeenCalledTimes(3);
  });

  it("reports a failed read as an error status, never as 0% used", async () => {
    const { handlers } = setup(async () => {
      throw new Error("host offline");
    });
    const out = await get(handlers);
    expect(out.usage).toEqual({ status: "error", plan: null, accountEmail: null, planLabel: null, message: "host offline" });
    expect(out.observedAt).toBeNull();
  });

  it("keeps the last success time when a later read fails", async () => {
    let now = 1_000;
    const { handlers, readHostUsage } = setup(async () => sampleUsage, () => now);
    await get(handlers, true);
    readHostUsage.mockRejectedValueOnce(new Error("host offline"));
    now = 2_000;
    const out = await get(handlers, true);
    expect(out.observedAt).toBe(1_000);
    expect(out.usage).toMatchObject({ status: "error", message: "host offline" });
  });

  it.each(["not_installed", "unauthenticated"] as const)("passes a %s host through as that state", async (status) => {
    const { handlers } = setup(async () => ({ status, plan: null, accountEmail: null, planLabel: null }));
    expect((await get(handlers)).usage).toEqual({ status, plan: null, accountEmail: null, planLabel: null });
  });

  it("owns only its own resource ids and rejects any other", async () => {
    const { handlers } = setup();
    expect(handlers.owns("antigravity:host_a")).toBe(true);
    for (const id of ["grok:host_a", "claude-code:host_a", "codex:host_a", "other"]) expect(handlers.owns(id)).toBe(false);
    await expect(get(handlers, false, "grok:host_a")).rejects.toThrow(/Unknown resource/);
  });

  it("combines with Usage Pace's other sources without claiming their resources", async () => {
    const { handlers } = setup();
    const subscription = createSubscriptionUsageSource(fakeBb(), async () => ({ accountKey: null, usage: sampleUsage }));
    const combined = combineUsageSources([subscription, handlers]);
    const ids = (await combined[LIST]()).resources.map((resource) => resource.id);
    expect(ids).toContain("antigravity:host_a");
    expect(ids.filter((id) => id !== "antigravity:host_a").every((id) => !handlers.owns(id))).toBe(true);
    expect((await combined[GET]({ resourceId: "antigravity:host_a", refresh: false })).usage).toEqual(sampleUsage);
  });
});
