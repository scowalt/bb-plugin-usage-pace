import type { UsageAccount, UsageWindow } from "../server";
import type { UsageState } from "./usage-store";
import { accountId, mergeAccounts, observationTime, usageIsStale } from "./usage-accounts";
import { formatReset } from "./usage-store";
import { describePace, formatDuration, paceForWindows, toneForUsed, windowDurationMs, type Pace, type Tone } from "./pace";

const HOUR = 3_600_000;

export interface CompactWindow {
  window: UsageWindow;
  label: string;
  detail: string;
  pace: Pace | null;
  paceState: "known" | "early" | "unknown";
  usageKnown: boolean;
}

interface CompactStatus {
  glyph: "●" | "▲" | "⌛" | "—";
  tone: Tone | null;
  detail: string;
}

export interface CompactUsageRow {
  key: string;
  provider: UsageAccount;
  windows: CompactWindow[];
  status: CompactStatus;
  notice: { label: string; tone: Tone | null } | null;
  countdown: {
    label: string;
    detail: string;
    resetAtMs?: number;
  } | null;
  title: string;
}

function shortLabel(window: UsageWindow): string {
  if (window.weekly) return "W";
  const duration = window.kind === "five-hour" ? 5 * HOUR : window.kind === "daily" ? 24 * HOUR : windowDurationMs(window.label);
  if (duration === 5 * HOUR) return "S";
  if (duration === 24 * HOUR) return "D";
  if (/\bmonth(ly)?\b/iu.test(window.label)) return "M";
  return window.label;
}

function statusFor(windows: UsageWindow[], paces: (Pace | null)[], error: string | null, now: number, reset: CompactUsageRow["countdown"]): CompactStatus {
  if (reset?.resetAtMs !== undefined && reset.resetAtMs <= now) {
    return { glyph: "⌛", tone: "warning", detail: `Scheduled reset passed. Awaiting refreshed usage.${error ? ` Usage may be stale or incomplete. ${error}` : ""}` };
  }
  if (error) return { glyph: "—", tone: null, detail: `Usage may be stale or incomplete. ${error}` };
  if (reset !== null) {
    return { glyph: "⌛", tone: "warning", detail: "A quota window is exhausted." };
  }
  if (windows.some(window => window.resetsAt !== null && Date.parse(window.resetsAt) <= now)) {
    return { glyph: "—", tone: null, detail: "Reset passed since last update. Refresh usage." };
  }
  if (paces.some(pace => pace !== null && pace.lockoutMs > 0)) {
    return { glyph: "▲", tone: "critical", detail: "At this rate, a quota window runs out before reset." };
  }
  if (paces.some(pace => pace === null || pace.ratio === null)) {
    return { glyph: "—", tone: null, detail: "Pace unavailable or too early to judge for a quota window." };
  }
  if (paces.some(pace => pace?.tone !== "ok")) {
    const detail = windows.some(window => toneForUsed(window.usedPercent) !== "ok")
      ? "Lasts to reset at this rate, but a quota window is near its limit."
      : "Lasts to reset at this rate, but projected quota use is high.";
    return { glyph: "●", tone: "warning", detail };
  }
  return { glyph: "●", tone: "ok", detail: "All quota windows last to reset at this rate." };
}

function resetCountdownFor(windows: UsageWindow[], now: number): CompactUsageRow["countdown"] {
  const exhausted = windows.filter(window => window.usedPercent >= 100);
  if (exhausted.length === 0) return null;
  const resets = exhausted.map(window => Date.parse(window.resetsAt ?? ""));
  if (resets.some(at => !Number.isFinite(at))) {
    return { label: "reset unknown", detail: `${exhausted.map(window => window.label).join(", ")}: quota exhausted; at least one reset time is unavailable.` };
  }
  const resetAtMs = Math.max(...resets);
  const last = exhausted[resets.indexOf(resetAtMs)]!;
  const remaining = resetAtMs - now;
  if (remaining <= 0) {
    return { label: "awaiting refresh", detail: "Scheduled resets for the reported exhausted windows have passed. Awaiting refreshed usage.", resetAtMs };
  }
  const label = `resets in ${remaining < 60_000 ? "<1m" : formatDuration(remaining)}`;
  return { label, detail: `${last.label}: ${label} (latest reset among exhausted windows).`, resetAtMs };
}

function countdownFor(windows: UsageWindow[], paces: (Pace | null)[], now: number): CompactUsageRow["countdown"] {
  let first: { window: UsageWindow; at: number; shortfallMs: number } | null = null;
  for (const [index, pace] of paces.entries()) {
    if (pace === null || pace.runsOutAtMs === null) continue;
    const at = pace.runsOutAtMs;
    if (first === null || at < first.at) {
      first = { window: windows[index]!, at, shortfallMs: pace.lockoutMs };
    }
  }
  if (first === null) return null;
  const remaining = first.at - now;
  const runOut = remaining <= 0 ? "out now (est.)"
    : remaining < 60_000 ? "out in <1m" : `out in ${formatDuration(remaining)}`;
  const shortfall = first.shortfallMs < 60_000 ? "<1m" : formatDuration(first.shortfallMs).replace(/ 0[hm]$/u, "");
  const label = remaining <= 0 ? runOut : `${shortfall} short`;
  return { label, detail: `${first.window.label}: projected to run out ${shortfall} before reset; ${runOut} at the last reported pace.` };
}

export function compactUsageRows(state: UsageState, now = Date.now()): CompactUsageRow[] {
  const rows: CompactUsageRow[] = [];
  for (const [index, provider] of mergeAccounts(state.data?.accounts ?? state.data?.providers ?? []).entries()) {
    if (provider.status !== "ok" && provider.status !== "error") continue;
    if (provider.status === "ok" && provider.windows.length === 0) continue;
    const key = `${accountId(provider)}${provider.accountKey === null ? `/${index}` : ""}`;
    const paceAt = observationTime(provider, state.data?.fetchedAt ?? "", now);
    const paces = paceForWindows(provider.windows, paceAt);
    const error = state.error ?? (provider.stale || provider.observedAt === null || provider.status !== "ok" ? provider.message ?? "Usage unavailable." : null);
    const unreliable = error !== null || usageIsStale(provider, now);
    const allWindows = provider.windows.map((window, index): CompactWindow => {
      const reset = formatReset(window.resetsAt, now);
      const pace = unreliable ? null : paces[index]!;
      const expired = window.resetsAt !== null && Date.parse(window.resetsAt) <= now;
      const detail = [
        unreliable ? `${window.label}: usage unknown` : `${window.label}: ${Math.round(window.usedPercent)}% used`,
        reset ? (expired ? "reset passed; refresh usage" : `resets in ${reset}`) : "reset unavailable",
        expired ? "" : describePace(pace, now) || "pace unavailable",
      ].filter(Boolean).join(" · ");
      return { window, label: shortLabel(window), detail, pace, usageKnown: !unreliable,
        paceState: pace === null ? "unknown" : pace.ratio === null ? "early" : "known" };
    });
    const weekly = allWindows.find(entry => entry.window.weekly);
    const session = allWindows.find(entry => entry.window.kind === "five-hour" || windowDurationMs(entry.window.label) === 5 * HOUR);
    const selected = [weekly, session].filter((entry): entry is CompactWindow => entry !== undefined);
    if (selected.length === 0 && allWindows[0]) selected.push(allWindows[0]);
    const reset = resetCountdownFor(provider.windows, now);
    const status = statusFor(provider.windows, paces, error, now, reset);
    const countdown = status.glyph === "⌛" ? reset
      : status.glyph === "▲" ? countdownFor(provider.windows, paces, now) : null;
    const quotaWarning = !unreliable && countdown === null && allWindows.some(entry =>
      (entry.pace?.tone ?? toneForUsed(entry.window.usedPercent)) !== "ok");
    const warningLabel = allWindows.some(entry => toneForUsed(entry.window.usedPercent) !== "ok")
      ? "near limit" : "high projected use";
    const noticeLabel = [
      !unreliable && allWindows.some(entry => !selected.includes(entry) && entry.paceState !== "known") ? "other pace unknown" : null,
      quotaWarning ? warningLabel : null,
    ].filter(Boolean).join(" · ");
    const notice: CompactUsageRow["notice"] = selected.length === 0 ? { label: "usage unknown", tone: null }
      : noticeLabel ? { label: noticeLabel, tone: quotaWarning ? "warning" : null } : null;
    const identity = [provider.displayName, provider.accountLabel, provider.accountEmail, provider.hostName].filter(Boolean).join(" · ");
    rows.push({ key, provider, windows: selected, status, notice, countdown,
      title: [identity, status.detail, notice?.label, countdown?.detail, ...allWindows.map(entry => entry.detail),
        "1.0× is even pace. Below 1.0× uses less quota than even pace; above uses more. Average since window start, not an agent-count recommendation."].filter(Boolean).join("\n") });
  }
  return rows;
}
