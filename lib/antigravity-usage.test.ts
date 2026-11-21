import { afterAll, describe, expect, it, vi } from "vitest";
import { providerUsageResultSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { agyFixture, createFakeAgy, waitUntilDead } from "../tests/fake-agy";
import {
  cacheOkUsage,
  parseAgyUsage,
  readAgyUsage,
  readAntigravityHealth,
  readAntigravityUsage,
  toProviderUsage,
  usageFromRun,
} from "./antigravity-usage";
import { sourceUsageSchema, type SourceUsage } from "./usage-source-contract";

const fake = createFakeAgy();
afterAll(() => fake.dispose());

const sample: unknown = JSON.parse(agyFixture("agy-usage.json"));
const signedOutJson: unknown = JSON.parse(agyFixture("agy-usage-signed-out.json"));

const window = (kind: "weekly" | "five-hour", id: string, group: string, usedPercent: number, resetsAt: string) => ({
  kind,
  id,
  label: `${group} · ${kind === "weekly" ? "Weekly" : "5h"}`,
  usedPercent,
  resetsAt,
  model: group,
  cost: null,
});

const sampleWindows = [
  window("weekly", "gemini-weekly", "Gemini Models", 1, "2026-11-28T00:32:03.000Z"),
  window("five-hour", "gemini-5h", "Gemini Models", 1.01, "2026-11-21T05:32:03.000Z"),
  window("weekly", "3p-weekly", "Claude and GPT models", 0, "2026-11-28T00:35:39.000Z"),
  window("five-hour", "3p-5h", "Claude and GPT models", 0, "2026-11-21T05:35:39.000Z"),
  window("weekly", "gemini-argon-wtu-weekly", "Gemini 4 Argon", 0, "2026-11-28T00:35:39.000Z"),
];

const okUsage = (windows = sampleWindows): SourceUsage => ({
  status: "ok",
  plan: null,
  accountEmail: null,
  planLabel: null,
  windows,
});

function report(groups: unknown, extra: Record<string, unknown> = {}) {
  return { status: "SUCCESS", command: { name: "usage", data: { groups } }, ...extra };
}

function bucket(overrides: Record<string, unknown> = {}) {
  return { id: "b1", window: "weekly", remaining_fraction: 0.5, reset_time: "2026-11-28T00:00:00Z", ...overrides };
}

function windowsOf(usage: SourceUsage) {
  if (usage.status !== "ok") throw new Error(`expected ok, got ${usage.status}`);
  return usage.windows;
}

describe("parseAgyUsage", () => {
  it("turns agy's /usage report into one window per bucket", () => {
    const usage = parseAgyUsage(sample);
    expect(usage).toEqual(okUsage());
    expect(sourceUsageSchema.parse(usage)).toEqual(usage);
  });

  it("derives used percent from the remaining fraction, rounded to two decimals", () => {
    const usedFor = (remaining: number) =>
      windowsOf(parseAgyUsage(report([{ name: "G", buckets: [bucket({ remaining_fraction: remaining })] }])))[0]!.usedPercent;
    expect(usedFor(0.5)).toBe(50);
    expect(usedFor(0.123456)).toBe(87.65);
    expect(usedFor(1)).toBe(0);
    expect(usedFor(0)).toBe(100);
  });

  it("clamps fractions outside 0..1 instead of reporting impossible percentages", () => {
    const usedFor = (remaining: number) =>
      windowsOf(parseAgyUsage(report([{ name: "G", buckets: [bucket({ remaining_fraction: remaining })] }])))[0]!.usedPercent;
    expect(usedFor(1.2)).toBe(0);
    expect(usedFor(-0.5)).toBe(100);
  });

  it("keeps a window it does not know as a custom window named after agy's own word", () => {
    const [only] = windowsOf(parseAgyUsage(report([{ name: "G", buckets: [bucket({ window: "monthly" })] }])));
    expect(only).toMatchObject({ kind: "custom", label: "G · monthly" });
  });

  it("reports an unknown reset time as null", () => {
    const resets = (reset_time: unknown) =>
      windowsOf(parseAgyUsage(report([{ name: "G", buckets: [bucket({ reset_time })] }])))[0]!.resetsAt;
    expect(resets(undefined)).toBeNull();
    expect(resets("not a date")).toBeNull();
  });

  it("reports the signed-out JSON as unauthenticated", () => {
    expect(parseAgyUsage(signedOutJson)).toEqual({
      status: "unauthenticated",
      plan: null,
      accountEmail: null,
      planLabel: null,
    });
  });

  it("reports another agy error with its message", () => {
    expect(parseAgyUsage({ status: "ERROR", error: "quota service unavailable" })).toMatchObject({
      status: "error",
      message: expect.stringContaining("quota service unavailable"),
    });
  });

  it("refuses output from a command other than /usage, which could have been a real agent turn", () => {
    const usage = parseAgyUsage({
      status: "SUCCESS",
      response: "Hello! How can I help?",
      num_turns: 1,
      command: { name: "chat", data: { groups: [{ name: "G", buckets: [bucket()] }] } },
    });
    expect(usage).toMatchObject({ status: "error", message: expect.stringMatching(/did not run its \/usage command/) });
    expect(parseAgyUsage({ status: "SUCCESS", response: "Hello!" })).toMatchObject({ status: "error" });
  });

  it.each([
    ["null", null],
    ["a list", []],
    ["a string", "usage"],
    ["a report without groups", { status: "SUCCESS", command: { name: "usage", data: {} } }],
    ["a bucket without a fraction", report([{ name: "G", buckets: [{ id: "x", window: "weekly" }] }])],
    ["a bucket with a text fraction", report([{ name: "G", buckets: [bucket({ remaining_fraction: "half" })] }])],
    ["no groups", report([])],
    ["groups without buckets", report([{ name: "G", buckets: [] }])],
  ])("reports %s as an error, never as 0% used", (_name, payload) => {
    expect(parseAgyUsage(payload)).toMatchObject({ status: "error", message: expect.any(String) });
  });
});

describe("usageFromRun", () => {
  it("maps each way a run can end to a usage state", () => {
    expect(usageFromRun({ kind: "missing" }).status).toBe("not_installed");
    expect(usageFromRun({ kind: "signed-out" }).status).toBe("unauthenticated");
    expect(usageFromRun({ kind: "timed-out" })).toMatchObject({ status: "error", message: expect.any(String) });
    expect(usageFromRun({ kind: "failed", message: "EACCES" })).toMatchObject({
      status: "error",
      message: expect.stringContaining("EACCES"),
    });
    expect(usageFromRun({ kind: "exited", code: 0, stdout: JSON.stringify(sample) })).toEqual(okUsage());
  });

  it("reports output that is not JSON as an error with the exit code", () => {
    expect(usageFromRun({ kind: "exited", code: 1, stdout: "Segmentation fault" })).toMatchObject({
      status: "error",
      message: expect.stringContaining("exit code 1"),
    });
    expect(usageFromRun({ kind: "exited", code: null, stdout: "" }).status).toBe("error");
  });
});

describe("reading agy", () => {
  it("runs agy -p /usage --output-format json and parses its answer", async () => {
    const agy = fake.printingFixture("agy-usage.json");
    expect(await readAgyUsage({ commands: [agy.command] })).toEqual(okUsage());
    expect(agy.runs()).toBe(1);
  });

  it("reports a signed-out JSON answer as unauthenticated", async () => {
    const agy = fake.printingFixture("agy-usage-signed-out.json");
    expect((await readAgyUsage({ commands: [agy.command] })).status).toBe("unauthenticated");
  });

  it("reports a missing binary as not installed", async () => {
    expect((await readAgyUsage({ commands: [fake.missing()] })).status).toBe("not_installed");
  });

  it("falls back to the next command when the first is missing", async () => {
    const agy = fake.printingFixture("agy-usage.json");
    expect(await readAgyUsage({ commands: [fake.missing(), agy.command] })).toEqual(okUsage());
    expect((await readAgyUsage({ commands: [fake.missing(), fake.missing()] })).status).toBe("not_installed");
  });

  it("kills agy as soon as it asks for a login and reports unauthenticated", async () => {
    const agy = fake.signedOut();
    const started = Date.now();
    const usage = await readAgyUsage({ commands: [agy.command] });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(usage.status).toBe("unauthenticated");
    expect(await waitUntilDead(agy.pid())).toBe(true);
  });

  it("gives up on an agy that does not answer, kills it, and reports an error", async () => {
    const agy = fake.hanging();
    const started = Date.now();
    const usage = await readAgyUsage({ commands: [agy.command], timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(usage).toMatchObject({ status: "error", message: expect.any(String) });
    expect(await waitUntilDead(agy.pid())).toBe(true);
  });

  it("reports non-JSON output as an error", async () => {
    const agy = fake.printing("Welcome to agy\n");
    expect(await readAgyUsage({ commands: [agy.command] })).toMatchObject({ status: "error" });
  });

  it("reports a /usage that agy answered as another command as an error", async () => {
    const agy = fake.printing(JSON.stringify({ status: "SUCCESS", command: { name: "help", data: {} } }));
    expect(await readAgyUsage({ commands: [agy.command] })).toMatchObject({ status: "error" });
  });

  it("rejects when the caller aborts, and stops agy", async () => {
    const agy = fake.hanging();
    const controller = new AbortController();
    const pending = readAgyUsage({ commands: [agy.command], signal: controller.signal });
    await vi.waitFor(() => expect(agy.pid()).toBeGreaterThan(0));
    controller.abort(new Error("caller left"));
    await expect(pending).rejects.toThrow("caller left");
    expect(await waitUntilDead(agy.pid())).toBe(true);
  });
});

describe("cacheOkUsage", () => {
  const failed: SourceUsage = { status: "error", plan: null, accountEmail: null, planLabel: null, message: "boom" };

  it("answers from its cache until the ttl passes", async () => {
    let now = 0;
    const read = vi.fn(async () => okUsage());
    const cached = cacheOkUsage(read, 1_000, () => now);
    await cached();
    now = 999;
    await cached();
    expect(read).toHaveBeenCalledTimes(1);
    now = 1_000;
    await cached();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("never caches a result that is not ok", async () => {
    const read = vi.fn(async (): Promise<SourceUsage> => failed);
    const cached = cacheOkUsage(read, 1_000, () => 0);
    await cached();
    await cached();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("shares one read between concurrent callers", async () => {
    let release: (usage: SourceUsage) => void = () => {};
    const read = vi.fn(() => new Promise<SourceUsage>((resolve) => (release = resolve)));
    const cached = cacheOkUsage(read);
    const first = cached();
    const second = cached();
    release(okUsage());
    expect(await first).toEqual(await second);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("reads again after a read rejected", async () => {
    const read = vi.fn<() => Promise<SourceUsage>>().mockRejectedValueOnce(new Error("aborted")).mockResolvedValue(okUsage());
    const cached = cacheOkUsage(read);
    await expect(cached()).rejects.toThrow("aborted");
    expect(await cached()).toEqual(okUsage());
  });
});

describe("toProviderUsage", () => {
  const accepted = (usage: unknown) => providerUsageResultSchema.parse({ supported: true, usage });

  it("publishes windows with exactly a label, percent, reset, kind and id", () => {
    const usage = toProviderUsage(okUsage());
    expect(usage).toEqual({
      status: "ok",
      accountEmail: null,
      planLabel: null,
      windows: [
        { label: "Gemini Models · Weekly", usedPercent: 1, resetsAt: "2026-11-28T00:32:03.000Z", kind: "weekly", id: "gemini-weekly" },
        { label: "Gemini Models · 5h", usedPercent: 1.01, resetsAt: "2026-11-21T05:32:03.000Z", kind: "five-hour", id: "gemini-5h" },
        { label: "Claude and GPT models · Weekly", usedPercent: 0, resetsAt: "2026-11-28T00:35:39.000Z", kind: "weekly", id: "3p-weekly" },
        { label: "Claude and GPT models · 5h", usedPercent: 0, resetsAt: "2026-11-21T05:35:39.000Z", kind: "five-hour", id: "3p-5h" },
        { label: "Gemini 4 Argon · Weekly", usedPercent: 0, resetsAt: "2026-11-28T00:35:39.000Z", kind: "weekly", id: "gemini-argon-wtu-weekly" },
      ],
    });
    for (const published of usage.status === "ok" ? usage.windows : []) expect(published).not.toHaveProperty("cost");
  });

  it("passes bb's provider usage schema in every state", () => {
    const states: SourceUsage[] = [
      okUsage(),
      { status: "not_installed", plan: null, accountEmail: null, planLabel: null },
      { status: "unauthenticated", plan: null, accountEmail: null, planLabel: null },
      { status: "expired", plan: null, accountEmail: null, planLabel: null },
      { status: "error", plan: null, accountEmail: null, planLabel: null, message: "boom" },
    ];
    for (const state of states) {
      const parsed = accepted(toProviderUsage(state));
      expect(parsed.supported && parsed.usage.status).toBe(state.status);
    }
  });

  it("carries the error message", () => {
    expect(toProviderUsage({ status: "error", plan: null, accountEmail: null, planLabel: null, message: "boom" })).toEqual({
      status: "error",
      message: "boom",
      accountEmail: null,
      planLabel: null,
    });
  });
});

describe("the bridge's usage read", () => {
  const options = (command: string) => ({ acpLaunchSpec: { command } });

  it("reads agy from the launch spec's command and caches an ok answer", async () => {
    const agy = fake.printingFixture("agy-usage.json");
    const first = await readAntigravityUsage(options(agy.command));
    const second = await readAntigravityUsage(options(agy.command));
    expect(first).toEqual({ supported: true, usage: toProviderUsage(okUsage()) });
    expect(second).toEqual(first);
    expect(agy.runs()).toBe(1);
  });

  it("does not cache a signed-out answer", async () => {
    const agy = fake.signedOut();
    expect(await readAntigravityUsage(options(agy.command))).toEqual({ supported: true, usage: { status: "unauthenticated" } });
    await readAntigravityUsage(options(agy.command));
    expect(agy.runs()).toBe(2);
  });

  it("reports a missing binary as not installed", async () => {
    expect(await readAntigravityUsage(options(fake.missing()))).toEqual({ supported: true, usage: { status: "not_installed" } });
  });
});

describe("agy health", () => {
  const options = (command: string) => ({ acpLaunchSpec: { command } });

  it("reports the installed version as ready", async () => {
    expect(await readAntigravityHealth(options(fake.version("1.5.13")))).toEqual({
      supported: true,
      health: {
        status: "ready",
        statusMessage: null,
        accountEmail: null,
        planLabel: null,
        installedVersion: "1.5.13",
        minimumSupportedVersion: null,
        canInstall: false,
        canUpdate: false,
        loginCommand: null,
      },
    });
  });

  it("reports a missing binary as not installed", async () => {
    expect(await readAntigravityHealth(options(fake.missing()))).toMatchObject({
      supported: true,
      health: { status: "not_installed", installedVersion: null },
    });
  });

  it("does not report a binary that gave no version as missing", async () => {
    expect(await readAntigravityHealth(options(fake.version("")))).toMatchObject({
      supported: true,
      health: { status: "unknown", installedVersion: null },
    });
  });
});
