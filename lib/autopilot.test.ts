import { describe, expect, it } from "vitest";
import { makeAccount, NOW, at } from "../tests/usage-fixtures";
import { ANTIGRAVITY_PROVIDER_ID } from "./antigravity-provider";
import {
  DEFAULT_BANDS_TEXT,
  GEMINI_NEON,
  OPUS,
  autopilotApplies,
  chooseExecution,
  clampEffort,
  effortForPace,
  geminiRunnability,
  parseEffortBands,
  type AutopilotInput,
  type Runnability,
  type UsageReading,
} from "./autopilot";
import type { UsageAccount, UsageWindow } from "./usage-accounts";

const bands = parseEffortBands("").bands;
const runnable: Runnability = { runnable: true };
const fetchedAt = new Date(NOW).toISOString();

function weekly(usedPercent: number, resetsInHours = 84, model: string | null = null): UsageWindow {
  return { id: `weekly-${model}`, kind: "weekly", model, label: model ? `${model} · Weekly` : "Weekly limit", weekly: true, usedPercent, resetsAt: at(resetsInHours) };
}

function fiveHour(usedPercent: number, model: string | null = null): UsageWindow {
  return { id: `5h-${model}`, kind: "five-hour", model, label: model ? `${model} · 5h` : "Current session", weekly: false, usedPercent, resetsAt: at(2) };
}

function claudeAccount(key: string, windows: UsageWindow[], overrides: Partial<UsageAccount> = {}): UsageAccount {
  return makeAccount({ accountKey: key, accountEmail: `${key}@example.test`, weight: 10, windows, ...overrides });
}

function claudeAt(pace: number, extra: Partial<UsageAccount> = {}): UsageAccount[] {
  return [claudeAccount("a", [fiveHour(10), weekly(pace * 50)], extra)];
}

function geminiAccount(weeklyUsed: number, fiveHourUsed = 0, overrides: Partial<UsageAccount> = {}, resetsInHours = 84): UsageAccount {
  return makeAccount({
    id: ANTIGRAVITY_PROVIDER_ID, displayName: "Google Antigravity (usage)", accountKey: null, accountEmail: null,
    plan: null, planLabel: null, weight: null,
    windows: [weekly(weeklyUsed, resetsInHours, "Gemini Models"), fiveHour(fiveHourUsed, "Gemini Models")],
    ...overrides,
  });
}

const reading = (...groups: UsageAccount[][]): UsageReading => ({ accounts: groups.flat(), fetchedAt });

function decide(usage: UsageReading | null, overrides: Partial<AutopilotInput> = {}) {
  return chooseExecution({
    usage, gemini: runnable, hostId: null, settings: { enabled: true, bands }, now: NOW,
    request: { origin: "app", requested: { providerId: "pi", model: "claude-bridge/claude-opus-5-5", reasoningLevel: null } },
    ...overrides,
  });
}

describe("which subscription a new thread gets", () => {
  it("sends the thread to the subscription with the lower weekly pace", () => {
    const gemini = decide(reading(claudeAt(1.0), [geminiAccount(10)]));
    expect(gemini).toMatchObject({ providerId: GEMINI_NEON.providerId, model: GEMINI_NEON.model });
    expect(gemini?.reason).toContain("weekly pace 0.20× vs Claude 1.00×");
    const opus = decide(reading(claudeAt(0.4), [geminiAccount(40)]));
    expect(opus).toMatchObject({ providerId: OPUS.providerId, model: OPUS.model });
    expect(opus?.reason).toContain("weekly pace 0.40× vs Gemini Neon 0.80×");
  });

  it("goes to Opus on a tie within 0.02", () => {
    const choice = decide(reading(claudeAt(1.0), [geminiAccount(49.5)]));
    expect(choice?.providerId).toBe(OPUS.providerId);
    expect(choice?.reason).toContain("is a tie");
    expect(decide(reading(claudeAt(1.0), [geminiAccount(45)]))?.providerId).toBe(GEMINI_NEON.providerId);
  });

  it("goes to Opus when either usage is unknown", () => {
    const cold = decide(null);
    expect(cold).toMatchObject({ providerId: OPUS.providerId, reasoningLevel: "high" });
    expect(cold?.reason).toContain("overall pace unknown");
    const noGemini = decide(reading(claudeAt(1.0)));
    expect(noGemini?.providerId).toBe(OPUS.providerId);
    expect(noGemini?.reason).toContain("Gemini Neon skipped (its usage is unknown)");
    const staleClaude = decide(reading(claudeAt(1.0, { stale: true }), [geminiAccount(0)]));
    expect(staleClaude?.providerId).toBe(OPUS.providerId);
    expect(staleClaude?.reason).toContain("Claude usage unknown");
  });

  it("treats a Gemini reading past its reset as unknown", () => {
    const expired = geminiAccount(0, 0, {}, -1);
    expect(decide(reading(claudeAt(1.0), [expired]))?.providerId).toBe(OPUS.providerId);
  });

  it("prefers the Gemini reading from the thread's machine", () => {
    const here = geminiAccount(10, 0, { hosts: [{ id: "here", name: "Here" }], observedAt: NOW - 1000 });
    const there = geminiAccount(80, 0, { hosts: [{ id: "there", name: "There" }], observedAt: NOW });
    const choice = decide(reading(claudeAt(1.0), [there, here]), { hostId: "here" });
    expect(choice?.reason).toContain("weekly pace 0.20×");
  });

  it("weights Claude accounts by plan weight, as the pool does", () => {
    const big = claudeAccount("big", [weekly(25)], { weight: 10 });
    const small = claudeAccount("small", [weekly(100)], { weight: 1 });
    const choice = decide(reading([big, small], [geminiAccount(40)]));
    expect(choice?.providerId).toBe(OPUS.providerId);
    expect(choice?.reason).toContain("weekly pace 0.64× vs Gemini Neon 0.80×");
  });
});

describe("skipping a subscription", () => {
  it("skips Claude at 90% weekly, and not at 89%", () => {
    const busy = [geminiAccount(60)];
    expect(decide(reading([claudeAccount("a", [weekly(90)])], busy))?.reason).toContain("Claude skipped (weekly 90% used)");
    expect(decide(reading([claudeAccount("a", [weekly(90)])], busy))?.providerId).toBe(GEMINI_NEON.providerId);
    const below = decide(reading([claudeAccount("a", [weekly(89, 1)])], busy));
    expect(below?.providerId).toBe(OPUS.providerId);
    expect(below?.reason).not.toContain("skipped");
  });

  it("skips Claude only when every account's 5h window is at 85% or more", () => {
    const busy = [geminiAccount(60)];
    const both = [claudeAccount("a", [fiveHour(85), weekly(50)]), claudeAccount("b", [fiveHour(99), weekly(50)])];
    const choice = decide(reading(both, busy));
    expect(choice?.providerId).toBe(GEMINI_NEON.providerId);
    expect(choice?.reason).toContain("5h window at 85% or more on every account");
    const one = [claudeAccount("a", [fiveHour(85), weekly(50)]), claudeAccount("b", [fiveHour(84), weekly(50)])];
    expect(decide(reading(one, busy))?.providerId).toBe(OPUS.providerId);
    const noFiveHour = [claudeAccount("a", [fiveHour(99), weekly(50)]), claudeAccount("b", [weekly(50)])];
    expect(decide(reading(noFiveHour, busy))?.providerId).toBe(OPUS.providerId);
  });

  it("skips Claude when every account is out of weekly quota", () => {
    const spent = [claudeAccount("a", [weekly(100)]), claudeAccount("b", [weekly(100)])];
    expect(decide(reading(spent, [geminiAccount(60)]))?.providerId).toBe(GEMINI_NEON.providerId);
  });

  it("skips Gemini at 85% on its 5h window and at 90% weekly, not below", () => {
    const claude = claudeAt(1.0);
    const fiveHourSkip = decide(reading(claude, [geminiAccount(10, 85)]));
    expect(fiveHourSkip?.providerId).toBe(OPUS.providerId);
    expect(fiveHourSkip?.reason).toContain("Gemini Neon skipped (5h window 85% used)");
    const weeklySkip = decide(reading(claude, [geminiAccount(90)]));
    expect(weeklySkip?.providerId).toBe(OPUS.providerId);
    expect(weeklySkip?.reason).toContain("Gemini Neon skipped (weekly 90% used)");
    expect(decide(reading(claude, [geminiAccount(10, 84)]))?.providerId).toBe(GEMINI_NEON.providerId);
  });

  it("goes to Opus when both are skipped", () => {
    const choice = decide(reading([claudeAccount("a", [weekly(95)])], [geminiAccount(95)]));
    expect(choice?.providerId).toBe(OPUS.providerId);
    expect(choice?.reason).toContain("both skipped (Claude: weekly 95% used; Gemini Neon: weekly 95% used)");
  });

  it("goes to Opus when Gemini Neon cannot start on the machine", () => {
    const blocked: Runnability = { runnable: false, reason: "Antigravity is not available on this machine" };
    const choice = decide(reading(claudeAt(1.0), [geminiAccount(0)]), { gemini: blocked });
    expect(choice?.providerId).toBe(OPUS.providerId);
    expect(choice?.reason).toContain("Gemini Neon skipped (Antigravity is not available on this machine)");
  });
});

describe("early in a window", () => {
  it("uses used ÷ elapsed with elapsed floored at 5% when the ratio is null", () => {
    const early = geminiAccount(2, 0, {}, 167.9);
    const choice = decide(reading(claudeAt(1.0), [early]));
    expect(choice?.providerId).toBe(GEMINI_NEON.providerId);
    expect(choice?.reason).toContain("weekly pace 0.40× vs Claude 1.00×");
  });

  it("reads a Gemini account at 0% as pace 0", () => {
    const choice = decide(reading(claudeAt(1.0), [geminiAccount(0, 0, {}, 167.99)]));
    expect(choice?.reason).toContain("weekly pace 0.00× vs Claude 1.00×");
  });

  it("applies the same floor to an early Claude window", () => {
    const claude = [claudeAccount("a", [weekly(2, 167.9)])];
    const choice = decide(reading(claude, [geminiAccount(30)]));
    expect(choice?.providerId).toBe(OPUS.providerId);
    expect(choice?.reason).toContain("weekly pace 0.40× vs Gemini Neon 0.60×");
  });
});

describe("effort", () => {
  const atOverallPace = (overall: number) => decide(reading(claudeAt(overall), [geminiAccount(overall * 50)]));

  it.each([
    [0.5, "max"],
    [0.8, "xhigh"],
    [0.95, "high"],
    [1.1, "medium"],
    [1.7, "low"],
  ])("gives Opus %s× overall pace effort %s", (overall, level) => {
    const choice = atOverallPace(overall);
    expect(choice?.providerId).toBe(OPUS.providerId);
    expect(choice?.reasoningLevel).toBe(level);
  });

  it.each([
    [0.69, "max"],
    [0.7, "xhigh"],
    [0.89, "xhigh"],
    [0.9, "high"],
    [0.99, "high"],
    [1.0, "medium"],
    [1.19, "medium"],
    [1.2, "low"],
    [null, "high"],
  ])("puts %s× in the %s band", (overall, level) => {
    expect(effortForPace(bands, overall)).toBe(level);
  });

  it("clamps max to xhigh on Gemini Neon and says so", () => {
    const choice = decide(reading(claudeAt(1.0), [geminiAccount(0)]));
    expect(choice?.providerId).toBe(GEMINI_NEON.providerId);
    expect(choice?.reasoningLevel).toBe("xhigh");
    expect(choice?.reason).toContain("effort xhigh (max is not offered) at overall pace 0.50×");
  });

  it("averages the two paces for effort and falls back to Claude alone", () => {
    const both = decide(reading(claudeAt(0.8), [geminiAccount(60)]));
    expect(both?.providerId).toBe(OPUS.providerId);
    expect(both?.reasoningLevel).toBe("medium");
    expect(both?.reason).toContain("overall pace 1.00×");
    const alone = decide(reading(claudeAt(0.8)));
    expect(alone?.reasoningLevel).toBe("xhigh");
    expect(alone?.reason).toContain("overall pace 0.80×");
  });

  it("uses Gemini alone when Claude is unknown", () => {
    const choice = decide(reading(claudeAt(1.0, { stale: true }), [geminiAccount(50)]));
    expect(choice?.reasoningLevel).toBe("medium");
  });

  it("uses high when no pace is known", () => {
    expect(decide(reading([]))?.reasoningLevel).toBe("high");
  });

  it("follows the configured bands", () => {
    const custom = parseEffortBands("1.5=low,high").bands;
    expect(effortForPace(custom, 1.4)).toBe("low");
    expect(effortForPace(custom, 1.5)).toBe("high");
    expect(decide(reading(claudeAt(1.0)), { settings: { enabled: true, bands: custom } })?.reasoningLevel).toBe("low");
  });

  it("clamps to the nearest lower level a model has", () => {
    expect(clampEffort(GEMINI_NEON, "max")).toBe("xhigh");
    expect(clampEffort(GEMINI_NEON, "low")).toBe("low");
    expect(clampEffort(OPUS, "max")).toBe("max");
    expect(clampEffort({ ...OPUS, efforts: ["low", "high"] }, "medium")).toBe("low");
    expect(clampEffort({ ...OPUS, efforts: ["medium", "high"] }, "low")).toBe("medium");
  });
});

describe("effort band text", () => {
  it("parses the default", () => {
    const parsed = parseEffortBands(DEFAULT_BANDS_TEXT);
    expect(parsed.warning).toBeNull();
    expect(parsed.bands).toEqual({
      steps: [{ below: 0.7, level: "max" }, { below: 0.9, level: "xhigh" }, { below: 1, level: "high" }, { below: 1.2, level: "medium" }],
      rest: "low",
    });
  });

  it("accepts spaces and a lone level", () => {
    expect(parseEffortBands(" 2 = low , high ").bands).toEqual({ steps: [{ below: 2, level: "low" }], rest: "high" });
    expect(parseEffortBands("medium").bands).toEqual({ steps: [], rest: "medium" });
  });

  it("treats empty text as the default without a warning", () => {
    expect(parseEffortBands("  ")).toEqual({ bands: parseEffortBands(DEFAULT_BANDS_TEXT).bands, warning: null });
  });

  it.each([
    ["no final level", "0.7=max,0.9=xhigh"],
    ["an unknown level", "0.7=huge,low"],
    ["a bad number", "abc=max,low"],
    ["a zero threshold", "0=max,low"],
    ["thresholds out of order", "0.9=high,0.7=max,low"],
    ["a repeated threshold", "0.9=high,0.9=max,low"],
    ["a missing level", "0.7=,low"],
    ["extra equals signs", "0.7=max=low,low"],
  ])("falls back to the defaults with a warning for %s", (_name, text) => {
    const parsed = parseEffortBands(text);
    expect(parsed.bands).toEqual(parseEffortBands(DEFAULT_BANDS_TEXT).bands);
    expect(parsed.warning).toContain(text);
    expect(parsed.warning).toContain(DEFAULT_BANDS_TEXT);
  });
});

describe("which requests autopilot covers", () => {
  const request = (origin: string, providerId: string | null, model: string | null) => ({
    origin, requested: { providerId, model, reasoningLevel: null },
  });

  it("always covers composer threads, whatever the remembered model", () => {
    expect(autopilotApplies({ enabled: true }, request("app", "claude-code", "sonnet"))).toBe(true);
    expect(decide(reading(claudeAt(1.0)), { request: request("app", "claude-code", "sonnet") })).not.toBeNull();
  });

  it("covers other origins only when they name no provider and no model", () => {
    for (const origin of ["cli", "plugin", "sdk"]) {
      expect(autopilotApplies({ enabled: true }, request(origin, null, null))).toBe(true);
      expect(autopilotApplies({ enabled: true }, request(origin, "pi", null))).toBe(false);
      expect(autopilotApplies({ enabled: true }, request(origin, null, "gemini-4-neon"))).toBe(false);
      expect(autopilotApplies({ enabled: true }, request(origin, "pi", "claude-bridge/claude-opus-5-5"))).toBe(false);
    }
    expect(decide(reading(claudeAt(1.0)), { request: request("cli", "codex", null) })).toBeNull();
    expect(decide(reading(claudeAt(1.0)), { request: request("plugin", null, "gpt-5") })).toBeNull();
  });

  it("covers a spawn that names only an effort", () => {
    expect(decide(reading(claudeAt(1.0)), { request: { origin: "cli", requested: { providerId: null, model: null, reasoningLevel: "low" } } })).not.toBeNull();
  });

  it("chooses nothing when autopilot is off", () => {
    expect(decide(reading(claudeAt(1.0)), { settings: { enabled: false, bands }, request: request("app", null, null) })).toBeNull();
  });
});

describe("geminiRunnability", () => {
  const listed = { modelLoadError: null, models: [{ model: "gemini-4-argon" }, { model: GEMINI_NEON.model }] };
  const available = new Map([[GEMINI_NEON.providerId, true]]);

  it("is runnable when the provider is available and lists the model", () => {
    expect(geminiRunnability(available, listed, "Mac")).toEqual({ runnable: true });
  });

  it.each([
    ["providers unreadable", null, listed, "could not check Antigravity on Mac"],
    ["provider missing", new Map(), listed, "Antigravity is not available on Mac"],
    ["provider disabled", new Map([[GEMINI_NEON.providerId, false]]), listed, "Antigravity is not available on Mac"],
    ["catalog unreadable", available, null, "could not list Antigravity's models on Mac"],
    ["model load error", available, { modelLoadError: { code: "missing_executable" }, models: [] }, "Antigravity cannot start on Mac (missing_executable)"],
    ["model not listed", available, { modelLoadError: null, models: [{ model: "gemini-4-argon" }] }, "Antigravity does not list gemini-4-neon on Mac"],
  ] as const)("is not runnable when %s", (_name, providers, catalog, reason) => {
    expect(geminiRunnability(providers, catalog, "Mac")).toEqual({ runnable: false, reason });
  });
});
