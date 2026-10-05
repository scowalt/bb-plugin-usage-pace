import type { UsageProvider, UsageWindow } from "../server";
import type { UsageState } from "./usage-store";
import { formatReset } from "./usage-store";
import { describePace, formatDuration, paceForWindows, windowDurationMs, type Pace, type Tone } from "./pace";

const HOUR = 3_600_000;

export interface CompactWindow {
  window: UsageWindow;
  label: string;
  detail: string;
}

interface CompactStatus {
  glyph: "●" | "▲" | "⌛" | "—";
  tone: Tone | null;
  detail: string;
}

export interface CompactUsageRow {
  key: string;
  provider: UsageProvider;
  windows: CompactWindow[];
  status: CompactStatus;
  countdown: {
    label: string;
    detail: string;
    resetAtMs?: number;
  } | null;
  title: string;
}

function shortLabel(window: UsageWindow): string {
  if (window.weekly) return "W";
  const duration = windowDurationMs(window.label);
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
    return { glyph: "●", tone: "warning", detail: "Lasts to reset at this rate, but nearing a quota limit." };
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
  let first: { window: UsageWindow; at: number } | null = null;
  for (const [index, pace] of paces.entries()) {
    const at = pace?.runsOutAtMs;
    if (at != null && (first === null || at < first.at)) {
      first = { window: windows[index]!, at };
    }
  }
  if (first === null) return null;
  const remaining = first.at - now;
  const label = remaining <= 0 ? "out now (est.)"
    : remaining < 60_000 ? "out in <1m" : `out in ${formatDuration(remaining)}`;
  return { label, detail: `${first.window.label}: ${label} at the last reported pace.` };
}

export function compactUsageRows(state: UsageState, now = Date.now()): CompactUsageRow[] {
  const rows: CompactUsageRow[] = [];
  const seen = new Set<string>();
  const fetchedAt = Date.parse(state.data?.fetchedAt ?? "");
  const paceAt = Number.isFinite(fetchedAt) ? Math.min(fetchedAt, now) : now;
  for (const provider of state.data?.providers ?? []) {
    if (provider.status !== "ok" || provider.windows.length === 0) continue;
    const key = `${provider.id}/${provider.accountEmail ?? provider.hostId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const paces = paceForWindows(provider.windows, paceAt);
    const allWindows = provider.windows.map((window, index): CompactWindow => {
      const reset = formatReset(window.resetsAt, now);
      const pace = paces[index]!;
      const expired = window.resetsAt !== null && Date.parse(window.resetsAt) <= now;
      const detail = [
        `${window.label}: ${Math.round(window.usedPercent)}% used`,
        reset ? (expired ? "reset passed; refresh usage" : `resets in ${reset}`) : "reset unavailable",
        expired ? "" : describePace(pace, now) || "pace unavailable",
      ].filter(Boolean).join(" · ");
      return { window, label: shortLabel(window), detail };
    });
    const weekly = allWindows.find(entry => entry.window.weekly);
    const session = allWindows.find(entry => windowDurationMs(entry.window.label) === 5 * HOUR);
    const selected = [weekly, session].filter((entry): entry is CompactWindow => entry !== undefined);
    if (selected.length === 0) selected.push(allWindows[0]!);
    const reset = resetCountdownFor(provider.windows, now);
    const status = statusFor(provider.windows, paces, state.error ?? state.data?.error ?? null, now, reset);
    const countdown = status.glyph === "⌛" ? reset
      : status.glyph === "▲" ? countdownFor(provider.windows, paces, now) : null;
    const identity = [provider.displayName, provider.accountEmail, provider.hostName].filter(Boolean).join(" · ");
    rows.push({ key, provider, windows: selected, status, countdown,
      title: [identity, status.detail, countdown?.detail, ...allWindows.map(entry => entry.detail)].filter(Boolean).join("\n") });
  }
  return rows;
}
