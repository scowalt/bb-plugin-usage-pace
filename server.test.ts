import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { bankedResetsHostContract } from "./lib/banked-resets-host-contract";
import type { BankedResets } from "./lib/banked-resets-contract";

const inventory: BankedResets = { status: "ok", availableCount: 0, credits: [], accountEmail: "one@example.test", fetchedAt: "2026-10-07T20:00:00Z", message: null };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanups.splice(0)) await dispose(); });

async function setup() {
  const callHost = vi.fn(async ({ input }: { input: unknown }) => {
    const parsed = bankedResetsHostContract.readBankedResets.input.parse(input);
    return parsed.providerId === "claude-code"
      ? { ...inventory, sessionReset: { availability: "unavailable", reason: "not_at_wall", nextAvailableAt: null } }
      : inventory;
  });
  const { bb, harness } = createFakePluginHost({
    pluginId: "usage-pace", settings: { grokUsage: false },
    sdk: { hosts: { list: async () => [makeHostResponse({ id: "remote", status: "connected" }), makeHostResponse({ id: "offline", status: "disconnected" })] }, system: { config: async () => ({ primaryHostId: "remote" }) } },
    experimental_callHostRpc: callHost,
  });
  cleanups.push(() => harness.lifecycle.dispose());
  await plugin(bb);
  return { harness, callHost };
}

describe("reset RPC host routing", () => {
  it("dispatches Claude to the selected host and preserves the Codex default", async () => {
    const { harness, callHost } = await setup();
    expect(await harness.behavior.callRpc("getBankedResets", { hostId: "remote" })).toEqual(inventory);
    expect(callHost).toHaveBeenLastCalledWith(expect.objectContaining({ hostId: "remote", method: "readBankedResets", input: { force: false, providerId: "codex" } }));
    expect(await harness.behavior.callRpc("getBankedResets", { hostId: "remote", providerId: "claude-code", force: true })).toMatchObject({ sessionReset: { availability: "unavailable" } });
    expect(callHost).toHaveBeenLastCalledWith(expect.objectContaining({ hostId: "remote", method: "readBankedResets", input: { force: true, providerId: "claude-code" }, signal: expect.any(AbortSignal) }));
  });
  it.each(["offline", "missing"])("returns unknown without reading a %s host", async hostId => {
    const { harness, callHost } = await setup();
    expect(await harness.behavior.callRpc("getBankedResets", { hostId, providerId: "claude-code" })).toMatchObject({ status: "error", availableCount: null });
    expect(callHost).not.toHaveBeenCalled();
  });
  it("rejects unsupported providers and extraneous input before reaching the host", async () => {
    const { harness, callHost } = await setup();
    await expect(harness.behavior.callRpc("getBankedResets", { hostId: "remote", providerId: "other" })).rejects.toThrow();
    await expect(harness.behavior.callRpc("getBankedResets", { hostId: "remote", url: "https://other.test" })).rejects.toThrow();
    expect(callHost).not.toHaveBeenCalled();
  });
  it("returns unknown after a host failure rather than a zero balance", async () => {
    const { harness, callHost } = await setup();
    callHost.mockRejectedValueOnce(new Error("offline"));
    expect(await harness.behavior.callRpc("getBankedResets", { hostId: "remote", providerId: "claude-code" })).toMatchObject({ status: "error", availableCount: null });
  });
  it("keeps existing --resets CLI output and primary-host Codex behavior unchanged", async () => {
    const { harness, callHost } = await setup();
    const result = await harness.behavior.runCli(["--resets", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout ?? "")).toEqual({ hostId: "remote", ...inventory, truncated: false });
    expect(callHost).toHaveBeenCalledWith(expect.objectContaining({ input: { providerId: "codex", force: false } }));
  });
});
