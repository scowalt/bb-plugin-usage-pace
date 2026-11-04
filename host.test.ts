import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { bankedResetsUnavailable } from "./lib/banked-resets-contract";

const readers = vi.hoisted(() => ({ codex: vi.fn(), claude: vi.fn(), codexUsage: vi.fn(), claudeUsage: vi.fn() }));
vi.mock("./lib/banked-resets", () => ({ createBankedResetsReader: () => readers.codex }));
vi.mock("./lib/claude-limit-resets", () => ({ createClaudeLimitResetsReader: () => readers.claude }));
vi.mock("./lib/subscription-usage", () => ({ createClaudeUsageReader: () => readers.claudeUsage, createCodexUsageReader: () => readers.codexUsage }));
import entry from "./host";

let harness: ReturnType<typeof experimental_createHostEntryHarness<typeof entry.contract, {}>>;
beforeEach(() => {
  readers.codex.mockReset().mockResolvedValue(bankedResetsUnavailable("Codex fixture", "unauthenticated"));
  readers.claude.mockReset().mockResolvedValue(bankedResetsUnavailable("Claude fixture", "unauthenticated"));
  readers.codexUsage.mockReset().mockResolvedValue({ accountKey: null, usage: { status: "error", plan: null, accountEmail: null, planLabel: null, message: "Codex usage fixture" } });
  readers.claudeUsage.mockReset().mockResolvedValue({ accountKey: null, usage: { status: "error", plan: null, accountEmail: null, planLabel: null, message: "Claude usage fixture" } });
  harness = experimental_createHostEntryHarness(entry);
});
afterEach(async () => { await harness.experimental_dispose(); });

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
});
