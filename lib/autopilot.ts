import { ANTIGRAVITY_PROVIDER_ID } from "./antigravity-provider";
import type { NewThreadExecutionRequest } from "./new-thread-seam";
import { MIN_ELAPSED_FRACTION, paceForWindows } from "./pace";
import { isWeeklyWindow, observationTime, onHost, usageIsStale, type UsageAccount, type UsageWindow } from "./usage-accounts";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface AutopilotModel {
  name: string;
  providerId: string;
  model: string;
  efforts: readonly Effort[];
}

export const OPUS: AutopilotModel = {
  name: "Opus",
  providerId: "pi",
  model: "claude-bridge/claude-opus-5-5",
  efforts: EFFORTS,
};

export const GEMINI_NEON: AutopilotModel = {
  name: "Gemini Neon",
  providerId: "acp-antigravity-acp",
  model: "gemini-4-neon",
  efforts: ["low", "medium", "high", "xhigh"],
};

export const FIVE_HOUR_LIMIT_PERCENT = 85;
export const WEEKLY_LIMIT_PERCENT = 90;
export const TIE_PACE = 0.02;
export const UNKNOWN_EFFORT: Effort = "high";
export const DEFAULT_BANDS_TEXT = "0.7=max,0.9=xhigh,1.0=high,1.2=medium,low";

const CLAUDE_USAGE_ID = "claude-code";
const GEMINI_USAGE_GROUP = "Gemini Models";

export interface EffortBands {
  steps: readonly { below: number; level: Effort }[];
  rest: Effort;
}

const isEffort = (value: string): value is Effort => (EFFORTS as readonly string[]).includes(value);

function parseBands(text: string): EffortBands | string {
  const entries = text.split(",").map(entry => entry.trim()).filter(entry => entry !== "");
  const rest = entries.pop();
  if (rest === undefined) return "it is empty";
  if (!isEffort(rest)) return `the last entry must be a bare level (${EFFORTS.join(", ")}), not "${rest}"`;
  const steps: { below: number; level: Effort }[] = [];
  for (const entry of entries) {
    const [threshold, level, ...extra] = entry.split("=").map(part => part.trim());
    const below = Number(threshold);
    if (level === undefined || extra.length > 0 || threshold === "" || !Number.isFinite(below) || below <= 0) {
      return `"${entry}" is not pace=level`;
    }
    if (!isEffort(level)) return `"${level}" is not a level (${EFFORTS.join(", ")})`;
    if (steps.length > 0 && below <= steps[steps.length - 1]!.below) return `"${entry}" must be above the entry before it`;
    steps.push({ below, level });
  }
  return { steps, rest };
}

export function parseEffortBands(text: string): { bands: EffortBands; warning: string | null } {
  const fallback = parseBands(DEFAULT_BANDS_TEXT) as EffortBands;
  if (text.trim() === "") return { bands: fallback, warning: null };
  const parsed = parseBands(text);
  if (typeof parsed === "string") {
    return { bands: fallback, warning: `Ignoring the effort bands "${text}": ${parsed}. Using ${DEFAULT_BANDS_TEXT}.` };
  }
  return { bands: parsed, warning: null };
}

export function effortForPace(bands: EffortBands, pace: number | null): Effort {
  if (pace === null) return UNKNOWN_EFFORT;
  return bands.steps.find(step => pace < step.below)?.level ?? bands.rest;
}

export function clampEffort(model: AutopilotModel, wanted: Effort): Effort {
  const rank = EFFORTS.indexOf(wanted);
  const allowed = EFFORTS.filter((level, index) => index <= rank && model.efforts.includes(level));
  return allowed[allowed.length - 1] ?? model.efforts[0]!;
}

export type Runnability = { runnable: true } | { runnable: false; reason: string };

export interface ModelCatalog {
  modelLoadError: { code: string } | null;
  models: readonly { model: string }[];
}

export function geminiRunnability(
  providers: ReadonlyMap<string, boolean> | null,
  catalog: ModelCatalog | null,
  where: string,
): Runnability {
  const no = (reason: string): Runnability => ({ runnable: false, reason });
  if (providers === null) return no(`could not check Antigravity on ${where}`);
  if (providers.get(GEMINI_NEON.providerId) !== true) return no(`Antigravity is not available on ${where}`);
  if (catalog === null) return no(`could not list Antigravity's models on ${where}`);
  if (catalog.modelLoadError !== null) return no(`Antigravity cannot start on ${where} (${catalog.modelLoadError.code})`);
  if (!catalog.models.some(entry => entry.model === GEMINI_NEON.model)) return no(`Antigravity does not list ${GEMINI_NEON.model} on ${where}`);
  return { runnable: true };
}

export interface UsageReading {
  accounts: readonly UsageAccount[];
  fetchedAt: string;
}

export interface AutopilotSettings {
  enabled: boolean;
  bands: EffortBands;
}

export type AutopilotRequest = Pick<NewThreadExecutionRequest, "origin" | "requested">;

export interface AutopilotInput {
  usage: UsageReading | null;
  gemini: Runnability;
  hostId: string | null;
  settings: AutopilotSettings;
  request: AutopilotRequest;
  now: number;
}

export interface AutopilotChoice {
  providerId: string;
  model: string;
  reasoningLevel: Effort;
  reason: string;
}

export function autopilotApplies(settings: Pick<AutopilotSettings, "enabled">, request: AutopilotRequest): boolean {
  if (!settings.enabled) return false;
  if (request.origin === "app") return true;
  return request.requested.providerId === null && request.requested.model === null;
}

interface Standing {
  pace: number | null;
  blocked: string | null;
}

const percent = (value: number) => `${Math.round(value)}%`;
const times = (value: number) => `${value.toFixed(2)}×`;

function weeklyOf(account: UsageAccount, belongs: (window: UsageWindow) => boolean): UsageWindow | undefined {
  return account.windows.find(window => belongs(window) && isWeeklyWindow(window));
}

function fiveHourOf(account: UsageAccount, belongs: (window: UsageWindow) => boolean): UsageWindow | undefined {
  return account.windows.find(window => belongs(window) && (window.kind === "five-hour" || /\b5h\b/iu.test(window.label)));
}

function weeklyPace(account: UsageAccount, window: UsageWindow, fetchedAt: string, now: number): { used: number; elapsed: number } | null {
  const pace = paceForWindows([window], observationTime(account, fetchedAt, now))[0];
  if (!pace) return null;
  return { used: window.usedPercent / 100, elapsed: pace.ratio === null ? Math.max(pace.elapsedFraction, MIN_ELAPSED_FRACTION) : pace.elapsedFraction };
}

function pacedRatio(parts: { weight: number; used: number; elapsed: number }[]): number | null {
  const budget = parts.reduce((sum, part) => sum + part.weight * part.elapsed, 0);
  if (parts.length === 0 || budget <= 0) return null;
  return parts.reduce((sum, part) => sum + part.weight * part.used, 0) / budget;
}

function claudeStanding(usage: UsageReading, now: number): Standing {
  const healthy = usage.accounts.filter(account => account.id === CLAUDE_USAGE_ID && account.status === "ok" && !usageIsStale(account, now));
  const shared = (window: UsageWindow) => window.model == null;
  const weekly = healthy.flatMap(account => {
    const window = weeklyOf(account, shared);
    return window ? [{ account, window }] : [];
  });
  if (weekly.length === 0) return { pace: null, blocked: null };
  const weightOf = (account: UsageAccount) => account.weight ?? 1;
  const totalWeight = weekly.reduce((sum, { account }) => sum + weightOf(account), 0);
  const used = weekly.reduce((sum, { account, window }) => sum + weightOf(account) * window.usedPercent, 0) / totalWeight;
  const parts = weekly.map(({ account, window }) => ({ weight: weightOf(account), reading: weeklyPace(account, window, usage.fetchedAt, now) }));
  const pace = parts.every(part => part.reading !== null)
    ? pacedRatio(parts.map(part => ({ weight: part.weight, ...part.reading! })))
    : null;
  const fiveHours = weekly.map(({ account }) => fiveHourOf(account, shared));
  const blocked =
    used >= WEEKLY_LIMIT_PERCENT ? `weekly ${percent(used)} used`
      : fiveHours.every(window => window !== undefined && window.usedPercent >= FIVE_HOUR_LIMIT_PERCENT) ? `5h window at ${FIVE_HOUR_LIMIT_PERCENT}% or more on every account`
        : null;
  return { pace, blocked };
}

function geminiStanding(usage: UsageReading, hostId: string | null, now: number): Standing {
  const group = (window: UsageWindow) => window.model === GEMINI_USAGE_GROUP;
  const candidates = usage.accounts
    .filter(account => account.id === ANTIGRAVITY_PROVIDER_ID && account.status === "ok" && !usageIsStale(account, now) && weeklyOf(account, group) !== undefined)
    .sort((a, b) => Number(hostId !== null && onHost(b, hostId)) - Number(hostId !== null && onHost(a, hostId)) || (b.observedAt ?? 0) - (a.observedAt ?? 0));
  const account = candidates[0];
  const window = account && weeklyOf(account, group);
  if (!account || !window) return { pace: null, blocked: null };
  const reading = weeklyPace(account, window, usage.fetchedAt, now);
  const fiveHour = fiveHourOf(account, group);
  const blocked =
    fiveHour && fiveHour.usedPercent >= FIVE_HOUR_LIMIT_PERCENT ? `5h window ${percent(fiveHour.usedPercent)} used`
      : window.usedPercent >= WEEKLY_LIMIT_PERCENT ? `weekly ${percent(window.usedPercent)} used`
        : null;
  return { pace: reading === null ? null : pacedRatio([{ weight: 1, ...reading }]), blocked };
}

function mean(values: (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0) / known.length;
}

export function chooseExecution(input: AutopilotInput): AutopilotChoice | null {
  const { usage, settings, request, now } = input;
  if (!autopilotApplies(settings, request)) return null;

  const claude = usage ? claudeStanding(usage, now) : { pace: null, blocked: null };
  const gemini = usage ? geminiStanding(usage, input.hostId, now) : { pace: null, blocked: null };
  const geminiSkipped =
    gemini.blocked !== null ? gemini.blocked
      : !input.gemini.runnable ? input.gemini.reason
        : gemini.pace === null ? "its usage is unknown"
          : null;

  const claudePace = claude.pace === null ? "Claude usage unknown" : `Claude weekly pace ${times(claude.pace)}`;
  const geminiPace = gemini.pace === null ? "Gemini usage unknown" : `Gemini weekly pace ${times(gemini.pace)}`;
  let model: AutopilotModel;
  let why: string;
  if (geminiSkipped !== null) {
    model = OPUS;
    why = claude.blocked !== null
      ? `both skipped (Claude: ${claude.blocked}; Gemini Neon: ${geminiSkipped})`
      : `Gemini Neon skipped (${geminiSkipped}); ${claudePace}`;
  } else if (claude.blocked !== null) {
    model = GEMINI_NEON;
    why = `Claude skipped (${claude.blocked}); ${geminiPace}`;
  } else if (claude.pace === null || gemini.pace === null) {
    model = OPUS;
    why = `${claudePace}, ${geminiPace}`;
  } else if (gemini.pace < claude.pace - TIE_PACE) {
    model = GEMINI_NEON;
    why = `weekly pace ${times(gemini.pace)} vs Claude ${times(claude.pace)}`;
  } else {
    model = OPUS;
    why = Math.abs(gemini.pace - claude.pace) <= TIE_PACE
      ? `weekly pace ${times(claude.pace)} vs Gemini Neon ${times(gemini.pace)} is a tie`
      : `weekly pace ${times(claude.pace)} vs Gemini Neon ${times(gemini.pace)}`;
  }

  const overall = mean([claude.pace, gemini.pace]);
  const wanted = effortForPace(settings.bands, overall);
  const level = clampEffort(model, wanted);
  const clamp = level === wanted ? "" : ` (${wanted} is not offered)`;
  const effort = overall === null
    ? `effort ${level}, overall pace unknown`
    : `effort ${level}${clamp} at overall pace ${times(overall)}`;
  return {
    providerId: model.providerId,
    model: model.model,
    reasoningLevel: level,
    reason: `${model.name}: ${why}; ${effort}`,
  };
}
