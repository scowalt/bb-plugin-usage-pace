import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { providerUsageResultSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_createBridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { createFakeAgy } from "./tests/fake-agy";
import { bankedResetsUnavailable } from "./lib/banked-resets-contract";

const readers = vi.hoisted(() => ({
  codex: vi.fn(), claude: vi.fn(), codexUsage: vi.fn(), claudeUsage: vi.fn(), agyUsage: vi.fn(), grokHealth: vi.fn(), grokUsage: vi.fn(),
}));
vi.mock("./lib/grok-usage", () => ({ readGrokHealth: readers.grokHealth, readGrokUsage: readers.grokUsage }));
vi.mock("./lib/antigravity-usage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/antigravity-usage")>()),
  readAgyUsage: readers.agyUsage,
}));
vi.mock("./lib/banked-resets", () => ({ createBankedResetsReader: () => readers.codex }));
vi.mock("./lib/claude-limit-resets", () => ({ createClaudeLimitResetsReader: () => readers.claude }));
vi.mock("./lib/subscription-usage", () => ({ createClaudeUsageReader: () => readers.claudeUsage, createCodexUsageReader: () => readers.codexUsage }));
import entry, { experimental_providerBridge } from "./host";

let harness: ReturnType<typeof experimental_createHostEntryHarness<typeof entry.contract, {}>>;
beforeEach(() => {
  readers.codex.mockReset().mockResolvedValue(bankedResetsUnavailable("Codex fixture", "unauthenticated"));
  readers.claude.mockReset().mockResolvedValue(bankedResetsUnavailable("Claude fixture", "unauthenticated"));
  readers.codexUsage.mockReset().mockResolvedValue({ accountKey: null, usage: { status: "error", plan: null, accountEmail: null, planLabel: null, message: "Codex usage fixture" } });
  readers.claudeUsage.mockReset().mockResolvedValue({ accountKey: null, usage: { status: "error", plan: null, accountEmail: null, planLabel: null, message: "Claude usage fixture" } });
  readers.agyUsage.mockReset().mockResolvedValue({ status: "error", plan: null, accountEmail: null, planLabel: null, message: "Antigravity usage fixture" });
  readers.grokHealth.mockReset().mockResolvedValue({ supported: true, health: { status: "ready", installedVersion: "grok fixture" } });
  readers.grokUsage.mockReset().mockResolvedValue({ supported: true, usage: { status: "error", message: "Grok usage fixture", accountEmail: null, planLabel: null } });
  harness = experimental_createHostEntryHarness(entry);
});
afterEach(async () => { await harness.experimental_dispose(); });
const fake = createFakeAgy();
afterAll(() => fake.dispose());

it("defaults old host calls to Codex without reading Claude credentials", async () => {
  expect(await harness.experimental_call("readBankedResets", {})).toMatchObject({ message: "Codex fixture" });
  expect(readers.codex).toHaveBeenCalledWith(undefined, expect.any(AbortSignal));
  expect(readers.claude).not.toHaveBeenCalled();
});
it("routes Claude calls only to its reader with force and cancellation", async () => {
  expect(await harness.experimental_call("readBankedResets", { providerId: "claude-code", force: true })).toMatchObject({ message: "Claude fixture" });
  expect(readers.claude).toHaveBeenCalledWith(true, expect.any(AbortSignal));
  expect(readers.codex).not.toHaveBeenCalled();
});
it.each([
  ["claude-code", "claudeUsage", "codexUsage", "Claude usage fixture"],
  ["codex", "codexUsage", "claudeUsage", "Codex usage fixture"],
] as const)("routes %s usage reads only to its reader", async (providerId, reader, other, message) => {
  expect(await harness.experimental_call("readUsage", { providerId })).toMatchObject({ usage: { message } });
  expect(readers[reader]).toHaveBeenCalledWith(expect.any(AbortSignal));
  expect(readers[other]).not.toHaveBeenCalled();
  expect(readers.codex).not.toHaveBeenCalled();
  expect(readers.claude).not.toHaveBeenCalled();
  expect(readers.agyUsage).not.toHaveBeenCalled();
});
it("routes Antigravity usage reads only to agy, with cancellation and no account", async () => {
  expect(await harness.experimental_call("readUsage", { providerId: "usage-pace-antigravity" })).toEqual({
    accountKey: null,
    usage: { status: "error", plan: null, accountEmail: null, planLabel: null, message: "Antigravity usage fixture" },
  });
  expect(readers.agyUsage).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
  expect(readers.claudeUsage).not.toHaveBeenCalled();
  expect(readers.codexUsage).not.toHaveBeenCalled();
});
it("rejects a usage read for a provider it does not serve", async () => {
  await expect(harness.experimental_call("readUsage", { providerId: "usage-pace-grok" } as never)).rejects.toThrow();
  expect(readers.agyUsage).not.toHaveBeenCalled();
});

let bridge: ReturnType<typeof experimental_createBridgeJsonRpcTestHarness>;
beforeEach(() => { bridge = experimental_createBridgeJsonRpcTestHarness(experimental_providerBridge.handleLine); });
afterEach(() => { bridge.restore(); });

async function ask(id: number, method: "provider/usage" | "provider/health", params: Record<string, unknown>) {
  bridge.sendRequest(id, method, params);
  return bridge.waitForResponse(id);
}
const launchedWith = (command: string) => ({ acpLaunchSpec: { command } });

it("answers the bridge's usage request for Antigravity from agy, not from Grok", async () => {
  const agy = fake.printingFixture("agy-usage.json");
  const response = await ask(1, "provider/usage", { providerId: "usage-pace-antigravity", providerOptions: launchedWith(agy.command) });
  expect(response.error).toBeUndefined();
  const result = providerUsageResultSchema.parse(response.result);
  if (!result.supported || result.usage.status !== "ok") throw new Error("expected ok usage");
  expect(result.usage).toMatchObject({ accountEmail: null, planLabel: null });
  expect(result.usage.windows).toEqual([
    { label: "Gemini Models · Weekly", usedPercent: 1, resetsAt: "2026-11-28T00:32:03.000Z", kind: "weekly", id: "gemini-weekly" },
    { label: "Gemini Models · 5h", usedPercent: 1.01, resetsAt: "2026-11-21T05:32:03.000Z", kind: "five-hour", id: "gemini-5h" },
    { label: "Claude and GPT models · Weekly", usedPercent: 0, resetsAt: "2026-11-28T00:35:39.000Z", kind: "weekly", id: "3p-weekly" },
    { label: "Claude and GPT models · 5h", usedPercent: 0, resetsAt: "2026-11-21T05:35:39.000Z", kind: "five-hour", id: "3p-5h" },
    { label: "Gemini 4 Argon · Weekly", usedPercent: 0, resetsAt: "2026-11-28T00:35:39.000Z", kind: "weekly", id: "gemini-argon-wtu-weekly" },
  ]);
  expect(agy.runs()).toBe(1);
  expect(readers.grokUsage).not.toHaveBeenCalled();
  expect(readers.grokHealth).not.toHaveBeenCalled();
});

it("answers a second bridge usage request from its five-minute cache", async () => {
  const agy = fake.printingFixture("agy-usage.json");
  const params = { providerId: "usage-pace-antigravity", providerOptions: launchedWith(agy.command) };
  const first = await ask(1, "provider/usage", params);
  const second = await ask(2, "provider/usage", params);
  expect(second.result).toEqual(first.result);
  expect(agy.runs()).toBe(1);
});

it("answers the bridge's health request for Antigravity from agy --version", async () => {
  const response = await ask(1, "provider/health", { providerId: "usage-pace-antigravity", providerOptions: launchedWith(fake.version("1.5.13")) });
  expect(response.result).toMatchObject({ supported: true, health: { status: "ready", installedVersion: "1.5.13" } });
  expect(readers.grokHealth).not.toHaveBeenCalled();
});

it("reports a machine without agy as not installed, so bb does not list the provider", async () => {
  const response = await ask(1, "provider/health", { providerId: "usage-pace-antigravity", providerOptions: launchedWith(fake.missing()) });
  expect(response.result).toMatchObject({ supported: true, health: { status: "not_installed" } });
  const usage = await ask(2, "provider/usage", { providerId: "usage-pace-antigravity", providerOptions: launchedWith(fake.missing()) });
  expect(usage.result).toEqual({ supported: true, usage: { status: "not_installed" } });
});

it.each([
  ["provider/usage", "grokUsage", "Grok usage fixture"],
  ["provider/health", "grokHealth", "grok fixture"],
] as const)("still sends Grok's %s request to Grok", async (method, reader, marker) => {
  const providerOptions = launchedWith("grok");
  const agy = fake.printingFixture("agy-usage.json");
  const response = await ask(1, method, { providerId: "usage-pace-grok", providerOptions });
  expect(JSON.stringify(response.result)).toContain(marker);
  expect(readers[reader]).toHaveBeenCalledWith(providerOptions);
  expect(agy.runs()).toBe(0);
});

it.each([
  ["an unknown provider", { providerId: "usage-pace-other" }],
  ["no provider", {}],
])("answers %s with a JSON-RPC error and reads nothing", async (_name, params) => {
  const response = await ask(1, "provider/usage", params);
  expect(response.result).toBeUndefined();
  expect(response.error).toMatchObject({ code: -32602 });
  expect(readers.grokUsage).not.toHaveBeenCalled();
  expect(readers.agyUsage).not.toHaveBeenCalled();
});
