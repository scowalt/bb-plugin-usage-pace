import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { bankedResetsHostContract } from "./lib/banked-resets-host-contract";
import { parseAgyUsage } from "./lib/antigravity-usage";
import { agyFixture } from "./tests/fake-agy";
import type { NewThreadExecutionChooser, NewThreadExecutionRequest } from "./lib/new-thread-seam";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanups.splice(0)) await dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const server = makeHostResponse({ id: "server", name: "Server", status: "connected" });

const request = (overrides: Partial<NewThreadExecutionRequest> = {}): NewThreadExecutionRequest => ({
  projectId: "project", hostId: "server", origin: "app", originPluginId: null, parentThreadId: null,
  requested: { providerId: "claude-code", model: "sonnet", reasoningLevel: null },
  sources: { providerId: "client-preference", model: "client-preference", reasoningLevel: null },
  ...overrides,
});

async function setup(options: { seam?: boolean; settings?: Record<string, boolean | string>; neon?: boolean; seamThrows?: boolean } = {}) {
  vi.useFakeTimers({ now: Date.parse("2026-11-20T21:00:00Z"), toFake: ["Date"] });
  const callHost = vi.fn(async ({ input }: { input: unknown }) => {
    const { providerId } = bankedResetsHostContract.readUsage.input.parse(input);
    if (providerId === "usage-pace-antigravity") return { accountKey: null, usage: parseAgyUsage(JSON.parse(agyFixture("agy-usage.json"))) };
    return { accountKey: "anthropic:account:uuid-1", usage: {
      status: "ok", plan: null, accountEmail: "one@example.test", planLabel: null,
      windows: [{ kind: "weekly", id: "0:Weekly limit", label: "Weekly limit", usedPercent: 60, resetsAt: "2026-11-24T00:00:00.000Z", model: null, cost: null }],
    } };
  });
  let behavior: { callRpc(method: string, input: unknown): Promise<unknown> } | null = null;
  const { bb, harness } = createFakePluginHost({
    pluginId: "usage-pace", settings: { grokUsage: false, ...options.settings },
    sdk: {
      hosts: { list: async () => [server] },
      providers: {
        list: async () => [{ id: "usage-pace-antigravity" }, { id: "acp-antigravity-acp", available: options.neon !== false }],
        models: async () => ({ modelLoadError: null, models: [{ model: "gemini-4-neon" }] }),
      },
      system: { config: async () => ({ primaryHostId: "server" }) },
      plugins: {
        experimental_discoverRpc: async () => [{ pluginId: "usage-pace", displayName: "Usage Pace" }],
        callRpc: async ({ method, input }: { method: string; input: unknown }) => behavior!.callRpc(method, input),
      },
    },
    experimental_callHostRpc: callHost,
  });
  behavior = harness.behavior;
  const choosers: NewThreadExecutionChooser[] = [];
  if (options.seam !== false) {
    Object.assign(bb.providers, {
      experimental_chooseNewThreadExecution: (chooser: NewThreadExecutionChooser) => {
        if (options.seamThrows) throw new Error("another plugin already chooses");
        choosers.push(chooser);
      },
    });
  }
  const warn = vi.spyOn(bb.log, "warn");
  cleanups.push(() => harness.lifecycle.dispose());
  await plugin(bb);
  const choose = async (value: NewThreadExecutionRequest) => choosers[0]!(value, { signal: new AbortController().signal });
  return { harness, choosers, choose, warn };
}

describe("autopilot registration", () => {
  it("registers one chooser when the API exists and the setting is on", async () => {
    const { choosers } = await setup();
    expect(choosers).toHaveLength(1);
  });

  it("registers nothing on a bb without the API, and the CLI says nothing uses its choice", async () => {
    const { harness, choosers } = await setup({ seam: false });
    expect(choosers).toHaveLength(0);
    const result = await harness.behavior.runCli(["autopilot"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Not active: this bb has no new-thread chooser yet");
    expect(JSON.parse((await harness.behavior.runCli(["autopilot", "--json"])).stdout ?? "")).toMatchObject({ enabled: true, active: false });
  });

  it("does not register while the setting is off, then registers once when it is turned on", async () => {
    const { harness, choosers } = await setup({ settings: { autopilot: false } });
    expect(choosers).toHaveLength(0);
    await harness.behavior.setSettings({ autopilot: true });
    expect(choosers).toHaveLength(1);
    await harness.behavior.setSettings({ autopilotEffortBands: "1=low,high" });
    expect(choosers).toHaveLength(1);
  });

  it("keeps loading when another plugin already holds the chooser", async () => {
    const { choosers, warn } = await setup({ seamThrows: true });
    expect(choosers).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("another plugin already chooses"));
  });

  it("returns null once the setting is turned off, since the seam cannot unregister", async () => {
    const { harness, choose } = await setup();
    expect(await choose(request())).not.toBeNull();
    await harness.behavior.setSettings({ autopilot: false });
    expect(await choose(request())).toBeNull();
  });

  it("warns about bad effort bands and keeps the default", async () => {
    const { harness, warn, choose } = await setup({ settings: { autopilotEffortBands: "0.5=huge,low" } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Ignoring the effort bands"));
    expect(await choose(request())).toMatchObject({ reasoningLevel: "xhigh" });
    await harness.behavior.setSettings({ autopilotEffortBands: "9=low,low" });
    expect(await choose(request())).toMatchObject({ reasoningLevel: "low" });
  });
});

describe("autopilot choices", () => {
  it("picks Gemini Neon for a composer thread when its pace is lower", async () => {
    const { choose } = await setup();
    const choice = await choose(request());
    expect(choice).toMatchObject({ providerId: "acp-antigravity-acp", model: "gemini-4-neon", reasoningLevel: "xhigh" });
    expect(choice?.reason).toMatch(/^Gemini Neon: weekly pace 0\.\d\d× vs Claude 1\.\d\d×; effort xhigh \(max is not offered\)/u);
  });

  it("picks Opus when Gemini Neon is not available on the machine", async () => {
    const { choose } = await setup({ neon: false });
    const choice = await choose(request());
    expect(choice).toMatchObject({ providerId: "pi", model: "claude-bridge/claude-opus-5-5" });
    expect(choice?.reason).toContain("Antigravity is not available on this machine");
  });

  it("leaves a spawn that names a model alone", async () => {
    const { choose } = await setup();
    expect(await choose(request({ origin: "cli", requested: { providerId: "codex", model: null, reasoningLevel: null } }))).toBeNull();
    expect(await choose(request({ origin: "cli", requested: { providerId: null, model: null, reasoningLevel: null } }))).not.toBeNull();
  });
});

describe("bb usage-pace autopilot", () => {
  it("prints the choice and the reason", async () => {
    const { harness } = await setup();
    const result = await harness.behavior.runCli(["autopilot"]);
    expect(result.exitCode).toBe(0);
    const [first, second] = (result.stdout ?? "").split("\n");
    expect(first).toBe("New threads get acp-antigravity-acp · gemini-4-neon at effort xhigh.");
    expect(second).toMatch(/^Why: Gemini Neon: weekly pace /u);
  });

  it("prints JSON for a named machine", async () => {
    const { harness } = await setup();
    for (const args of [["autopilot", "--json", "--host", "server"], ["autopilot", "--host=server", "--json"]]) {
      const output = JSON.parse((await harness.behavior.runCli(args)).stdout ?? "");
      expect(output).toMatchObject({ enabled: true, active: true, hostId: "server", choice: { providerId: "acp-antigravity-acp", reasoningLevel: "xhigh" } });
    }
  });

  it("says autopilot is off when the setting is off", async () => {
    const { harness } = await setup({ settings: { autopilot: false } });
    expect((await harness.behavior.runCli(["autopilot"])).stdout).toContain("Autopilot is off");
    expect(JSON.parse((await harness.behavior.runCli(["autopilot", "--json"])).stdout ?? "")).toMatchObject({ enabled: false, choice: null });
  });

  it("rejects unknown arguments and a --host with no value", async () => {
    const { harness } = await setup();
    const unknown = await harness.behavior.runCli(["autopilot", "--bogus"]);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain("bb usage-pace autopilot [--json] [--host <id>]");
    const missing = await harness.behavior.runCli(["autopilot", "--host"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("--host needs a machine id");
  });
});
