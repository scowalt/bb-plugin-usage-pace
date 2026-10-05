
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export const MIN_ELAPSED_FRACTION = 0.05;
const MIN_USED_PERCENT = 5;

export type Tone = "ok" | "warning" | "critical";

export interface PaceInput {
  label: string;
  usedPercent: number;
  resetsAt: string | null;
}

export interface Pace {
  windowMs: number;
  resetsAtMs: number;
  elapsedFraction: number;
  ratio: number | null;
  projectedPercent: number | null;
  runsOutAtMs: number | null;
  lockoutMs: number;
  budgetPerHour: number;
  remainingMs: number;
  leftPercent: number;
  tone: Tone;
}

const UNIT_MS: Record<string, number> = {
  h: HOUR_MS,
  hr: HOUR_MS,
  hrs: HOUR_MS,
  hour: HOUR_MS,
  hours: HOUR_MS,
  d: DAY_MS,
  day: DAY_MS,
  days: DAY_MS,
  w: 7 * DAY_MS,
  wk: 7 * DAY_MS,
  week: 7 * DAY_MS,
  weeks: 7 * DAY_MS,
};

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  twelve: 12,
  thirty: 30,
};

const DURATION_PATTERN = new RegExp(
  String.raw`(\d+(?:\.\d+)?|${Object.keys(NUMBER_WORDS).join("|")})\s*[-‑]?\s*(hours?|hrs?|h|days?|d|weeks?|wk|w)\b`,
  "iu",
);

export function oneMonthBefore(atMs: number): number {
  const at = new Date(atMs);
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth() - 1;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(
    year,
    month,
    Math.min(at.getUTCDate(), lastDay),
    at.getUTCHours(),
    at.getUTCMinutes(),
    at.getUTCSeconds(),
    at.getUTCMilliseconds(),
  );
}

export function windowDurationMs(label: string, resetsAtMs?: number): number | null {
  const match = DURATION_PATTERN.exec(label);
  if (match !== null) {
    const unit = UNIT_MS[match[2]!.toLowerCase()];
    const amount = NUMBER_WORDS[match[1]!.toLowerCase()] ?? Number(match[1]);
    if (unit !== undefined && amount > 0) return amount * unit;
  }
  if (/\bweek(ly)?\b/iu.test(label)) return 7 * DAY_MS;
  if (/\bdaily\b/iu.test(label)) return DAY_MS;
  if (/\bmonth(ly)?\b/iu.test(label)) {
    if (resetsAtMs === undefined || !Number.isFinite(resetsAtMs)) return null;
    return resetsAtMs - oneMonthBefore(resetsAtMs);
  }
  if (/\bsession\b/iu.test(label)) return 5 * HOUR_MS;
  return null;
}

const SAME_RESET_MS = HOUR_MS;

export function windowLengths(windows: readonly PaceInput[]): (number | null)[] {
  const resets = windows.map((window) =>
    window.resetsAt === null ? Number.NaN : new Date(window.resetsAt).getTime(),
  );
  const fromLabels = windows.map((window, index) =>
    windowDurationMs(window.label, resets[index]),
  );
  return fromLabels.map((length, index) => {
    if (length !== null || !Number.isFinite(resets[index]!)) return length;
    const sibling = fromLabels.findIndex(
      (other, j) =>
        other !== null && Math.abs(resets[j]! - resets[index]!) < SAME_RESET_MS,
    );
    return sibling === -1 ? null : fromLabels[sibling]!;
  });
}

export function paceForWindows(
  windows: readonly PaceInput[],
  now = Date.now(),
): (Pace | null)[] {
  const lengths = windowLengths(windows);
  return windows.map((window, index) => paceFor(window, now, lengths[index]!));
}

function worse(a: Tone, b: Tone): Tone {
  const rank: Record<Tone, number> = { ok: 0, warning: 1, critical: 2 };
  return rank[a] >= rank[b] ? a : b;
}

export function toneForUsed(percent: number): Tone {
  if (percent >= 95) return "critical";
  if (percent >= 80) return "warning";
  return "ok";
}

export function toneForProjection(projected: number | null): Tone {
  if (projected === null) return "ok";
  if (projected > 100) return "critical";
  if (projected > 85) return "warning";
  return "ok";
}

export function paceFor(
  window: PaceInput,
  now = Date.now(),
  windowMs = windowDurationMs(
    window.label,
    window.resetsAt === null ? undefined : new Date(window.resetsAt).getTime(),
  ),
): Pace | null {
  if (windowMs === null || window.resetsAt === null) return null;
  const resetsAtMs = new Date(window.resetsAt).getTime();
  if (!Number.isFinite(resetsAtMs)) return null;

  const used = Math.max(0, Math.min(100, window.usedPercent));
  const remainingMs = Math.max(0, Math.min(windowMs, resetsAtMs - now));
  const elapsedMs = windowMs - remainingMs;
  const elapsedFraction = elapsedMs / windowMs;
  const early = elapsedMs <= 0 ||
    (elapsedFraction < MIN_ELAPSED_FRACTION && used < MIN_USED_PERCENT);

  const ratio = early ? null : used / (elapsedFraction * 100);
  const projectedPercent = early ? null : used / elapsedFraction;

  let runsOutAtMs: number | null = null;
  if (used >= 100) {
    runsOutAtMs = now;
  } else if (!early && used > 0) {
    const atMs = now + (elapsedMs * (100 - used)) / used;
    if (atMs < resetsAtMs) runsOutAtMs = atMs;
  }

  const budgetPerHour =
    remainingMs > 0 ? ((100 - used) * HOUR_MS) / remainingMs : 0;

  return {
    windowMs,
    resetsAtMs,
    elapsedFraction,
    ratio,
    projectedPercent,
    runsOutAtMs,
    lockoutMs: runsOutAtMs === null ? 0 : Math.max(0, resetsAtMs - runsOutAtMs),
    budgetPerHour,
    remainingMs,
    leftPercent: 100 - used,
    tone: worse(toneForUsed(used), toneForProjection(projectedPercent)),
  };
}

export function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function formatRatio(ratio: number): string {
  return `${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}×`;
}

const MIN_RATE_MS = 3 * HOUR_MS;

const percent = (value: number) =>
  `${value >= 10 ? Math.round(value) : Number(value.toFixed(1))}%`;

export function formatBudget(pace: Pace): string {
  if (pace.remainingMs >= DAY_MS) return `budget ${percent(pace.budgetPerHour * 24)}/day`;
  if (pace.remainingMs >= MIN_RATE_MS) return `budget ${percent(pace.budgetPerHour)}/h`;
  return `${percent(pace.leftPercent)} left for ${formatDuration(pace.remainingMs)}`;
}

const MAX_PROJECTED_PERCENT = 300;

export function formatProjection(projected: number): string {
  return projected > MAX_PROJECTED_PERCENT
    ? `on track for over ${MAX_PROJECTED_PERCENT}%`
    : `on track for ${Math.round(projected)}%`;
}

export function formatMoment(
  atMs: number,
  now = Date.now(),
  timeZone?: string,
  long = false,
): string {
  const day = (ms: number) =>
    new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "short" }).format(ms);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(atMs);
  const today = day(atMs) === day(now);
  if (!long) {
    if (today) return time;
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(atMs);
    return `${weekday} ${time}`;
  }
  if (today) return `today, ${time}`;
  const part = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-US", { timeZone, ...options }).format(atMs);
  const date = `${part({ weekday: "short" })} ${part({ day: "numeric" })} ${part({ month: "short" })}`;
  return `${date}, ${time}`;
}

export function formatRunsOut(
  pace: Pace | null,
  now = Date.now(),
  timeZone?: string,
  long = false,
): string | null {
  if (pace === null || pace.runsOutAtMs === null) return null;
  if (pace.runsOutAtMs <= now) return "now";
  return formatMoment(pace.runsOutAtMs, now, timeZone, long);
}

export function describeRate(pace: Pace | null): string {
  if (pace === null) return "";
  const budget = formatBudget(pace);
  if (pace.ratio === null || pace.projectedPercent === null) {
    return `too early to judge pace · ${budget}`;
  }
  return [
    `${formatRatio(pace.ratio)} pace`,
    formatProjection(pace.projectedPercent),
    budget,
  ].join(" · ");
}

const ON_PACE_POINTS = 1;

export function describeDelta(
  pace: Pace,
  usedPercent: number,
  now = Date.now(),
  timeZone?: string,
): [string, string] {
  if (pace.ratio === null) {
    return ["too early to judge pace", formatBudget(pace)];
  }
  const points = usedPercent - pace.elapsedFraction * 100;
  const ahead = formatDuration((Math.abs(points) / 100) * pace.windowMs);
  const first =
    Math.abs(points) < ON_PACE_POINTS
      ? "on pace"
      : points > 0
        ? `${Math.round(points)}% ahead of pace (${ahead})`
        : `${Math.round(-points)}% under pace (${ahead})`;
  const runsOut = formatRunsOut(pace, now, timeZone);
  const second =
    runsOut === null
      ? `lasts to reset · ${formatBudget(pace)}`
      : runsOut === "now"
        ? `out now · ${formatDuration(pace.lockoutMs)} without quota`
        : `runs out ${runsOut} · ${formatDuration(pace.lockoutMs)} without quota`;
  return [first, second];
}

export function describePace(pace: Pace | null, now = Date.now(), timeZone?: string): string {
  const rate = describeRate(pace);
  const runsOut = formatRunsOut(pace, now, timeZone);
  if (pace === null || runsOut === null) return rate;
  const lockout = `${formatDuration(pace.lockoutMs)} before reset`;
  return `runs out ${runsOut}, ${lockout} · ${rate}`;
}
