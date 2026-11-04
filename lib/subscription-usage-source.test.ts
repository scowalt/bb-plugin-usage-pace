import { describe, expect, it, vi } from "vitest";
import type { HostUsage } from "./subscription-usage";
import { createSubscriptionUsageSource } from "./subscription-usage-source";
import { combineUsageSources, usageSourceContract, type UsageSource } from "./usage-source-contract";

const LIST = "provider-usage.v1.listResources";
const GET = "provider-usage.v1.getResource";
const ok: HostUsage = {
  accountKey: "anthropic:account:uuid-1",
  usage: { status: "ok", plan: null, accountEmail: "one@example.test", planLabel: "Max (20x)", windows: [] },
};

function setup(providersByHost: Record<string, string[]> = { host_a: [], host_b: ["claude-code"] }) {
  const readHostUsage = vi.fn(async (_hostId: string, _providerId: string): Promise<HostUsage> => ok);
  const bb = {
    sdk: {
      hosts: {
        list: vi.fn(async () => [
          { id: "host_a", name: "Server", status: "connected" },
          { id: "host_b", name: "Laptop", status: "connected" },
          { id: "host_c", name: "Old", status: "disconnected" },
        ]),
      },
      providers: {
        list: vi.fn(async ({ hostId }: { hostId: string }) => {
          const ids = providersByHost[hostId];
          if (ids === undefined) throw new Error("unreachable");
          return ids.map(id => ({ id }));
        }),
      },
    },
  };
  return { bb: bb as never, readHostUsage };
}

async function list(source: Pick<UsageSource, typeof LIST>) {
  return usageSourceContract[LIST].output.parse(await source[LIST]());
}
async function get(source: Pick<UsageSource, typeof GET>, resourceId: string, refresh = false) {
  return usageSourceContract[GET].output.parse(await source[GET]({ resourceId, refresh }));
}

describe("Claude and Codex fallback usage source", () => {
  it("lists a provider only on connected hosts where bb's own provider does not report usage", async () => {
    const { bb, readHostUsage } = setup();
    const out = await list(createSubscriptionUsageSource(bb, readHostUsage));
    expect(out.resources.map(resource => resource.id)).toEqual(["claude-code:host_a", "codex:host_a", "codex:host_b"]);
    expect(out.resources[0]).toEqual({
      accountKey: null, id: "claude-code:host_a", providerId: "claude-code", label: "Claude Code",
      scope: { kind: "host", hostId: "host_a", hostName: "Server" },
    });
    expect(readHostUsage).not.toHaveBeenCalled();
  });

  it("lists nothing for a host whose providers cannot be checked, to avoid duplicating bb's source", async () => {
    const { bb, readHostUsage } = setup({ host_b: [] });
    const out = await list(createSubscriptionUsageSource(bb, readHostUsage));
    expect(out.resources.map(resource => resource.id)).toEqual(["claude-code:host_b", "codex:host_b"]);
  });

  it("reads usage from the resource's host and remembers its account key for the inventory", async () => {
    const { bb, readHostUsage } = setup();
    const source = createSubscriptionUsageSource(bb, readHostUsage, () => 1_000);
    expect(await get(source, "claude-code:host_a")).toEqual({ ...ok, observedAt: 1_000 });
    expect(readHostUsage).toHaveBeenCalledWith("host_a", "claude-code");
    expect((await list(source)).resources[0]?.accountKey).toBe("anthropic:account:uuid-1");
  });

  it("answers from its cache for five minutes unless asked to refresh", async () => {
    let now = 0;
    const { bb, readHostUsage } = setup();
    const source = createSubscriptionUsageSource(bb, readHostUsage, () => now);
    await get(source, "codex:host_a");
    now = 60_000;
    await get(source, "codex:host_a");
    expect(readHostUsage).toHaveBeenCalledTimes(1);
    await get(source, "codex:host_a", true);
    expect(readHostUsage).toHaveBeenCalledTimes(2);
    now = 60_000 + 5 * 60_000;
    await get(source, "codex:host_a");
    expect(readHostUsage).toHaveBeenCalledTimes(3);
  });

  it("keeps the last success time and account key when the host read fails", async () => {
    let now = 1_000;
    const { bb, readHostUsage } = setup();
    const source = createSubscriptionUsageSource(bb, readHostUsage, () => now);
    await get(source, "claude-code:host_a", true);
    readHostUsage.mockRejectedValueOnce(new Error("host offline"));
    now = 2_000;
    expect(await get(source, "claude-code:host_a", true)).toEqual({
      accountKey: "anthropic:account:uuid-1", observedAt: 1_000,
      usage: { status: "error", plan: null, accountEmail: null, planLabel: null, message: "host offline" },
    });
  });

  it("rejects resources it does not own", async () => {
    const { bb, readHostUsage } = setup();
    const source = createSubscriptionUsageSource(bb, readHostUsage);
    for (const id of ["grok:host_a", "claude-code:", "cursor:host_a"]) {
      expect(source.owns(id)).toBe(false);
      await expect(get(source, id)).rejects.toThrow(/Unknown resource/);
    }
  });
});

describe("combined usage sources", () => {
  const fake = (prefix: string): UsageSource => ({
    owns: id => id.startsWith(prefix),
    [LIST]: async () => ({ resources: [{ accountKey: null, id: `${prefix}one`, providerId: prefix, label: prefix, scope: { kind: "shared" } }] }),
    [GET]: async () => ({ accountKey: null, observedAt: null, usage: { status: "error", plan: null, accountEmail: null, planLabel: null, message: prefix } }),
  });

  it("lists every source's resources and routes reads to the owning source", async () => {
    const combined = combineUsageSources([fake("a:"), fake("b:")]);
    expect((await list(combined)).resources.map(resource => resource.id)).toEqual(["a:one", "b:one"]);
    expect((await get(combined, "b:one")).usage).toMatchObject({ message: "b:" });
    expect(() => combined[GET]({ resourceId: "c:one", refresh: false })).toThrow(/Unknown resource/);
  });
});
