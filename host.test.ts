import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { bankedResetsUnavailable } from "./lib/banked-resets-contract";

const readers = vi.hoisted(() => ({ codex: vi.fn(), claude: vi.fn() }));
vi.mock("./lib/banked-resets", () => ({ createBankedResetsReader: () => readers.codex }));
vi.mock("./lib/claude-limit-resets", () => ({ createClaudeLimitResetsReader: () => readers.claude }));
import entry from "./host";

let harness: ReturnType<typeof experimental_createHostEntryHarness<typeof entry.contract, {}>>;
beforeEach(() => {
  readers.codex.mockReset().mockResolvedValue(bankedResetsUnavailable("Codex fixture", "unauthenticated"));
  readers.claude.mockReset().mockResolvedValue(bankedResetsUnavailable("Claude fixture", "unauthenticated"));
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
