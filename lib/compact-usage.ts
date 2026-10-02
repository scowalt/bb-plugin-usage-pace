import type { UsageProvider, UsageWindow } from "../server";
import type { UsageState } from "./usage-store";
import { formatReset } from "./usage-store";
import { describePace, paceForWindows, windowDurationMs, type Pace, type Tone } from "./pace";

const HOUR = 3_600_000;

export interface CompactWindow {
  window: UsageWindow;
  label: string;
  detail: string;
}

interface CompactStatus {
  glyph: "●" | "▲" | "—";
  tone: Tone | null;
  detail: string;
}

export interface CompactUsageRow {
  key: string;
  provider: UsageProvider;
  windows: CompactWindow[];
  status: CompactStatus;
  title: string;
}

function shortLabel(window: UsageWindow): string {
  if (window.weekly) return "W";
  const duration = windowDurationMs(window.label);
  if (duration === 5 * HOUR) return "S";
  if (duration === 24 * HOUR) return "D";
  if (/\bmonth(ly)?\b/iu.test(window.label)) return "M";
  // Don't mislabel arbitrary provider limits as sessions.
  return window.label;
}

function statusFor(windows: UsageWindow[], paces: (Pace | null)[], error: string | null, now: number): CompactStatus {
  if (error) return { glyph: "—", tone: null, detail: `Usage may be stale or incomplete. ${error}` };
  if (windows.some(window => window.resetsAt !== null && Date.parse(window.resetsAt) <= now)) {
    return { glyph: "—", tone: null, detail: "Reset passed since last update. Refresh usage." };
  }
  if (windows.some(window => window.usedPercent >= 100)) {
    return { glyph: "▲", tone: "critical", detail: "A quota window is exhausted." };
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

/** One row per provider/account; W and S first, other limits remain in details. */
export function compactUsageRows(state: UsageState, now = Date.now()): CompactUsageRow[] {
  const rows: CompactUsageRow[] = [];
  const seen = new Set<string>();
  for (const provider of state.data?.providers ?? []) {
    if (provider.status !== "ok" || provider.windows.length === 0) continue;
    const key = `${provider.id}/${provider.accountEmail ?? provider.hostId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const paces = paceForWindows(provider.windows, now);
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
    // Monthly/daily/unknown windows still have a useful row, without inventing W/S values.
    if (selected.length === 0) selected.push(allWindows[0]!);
    const status = statusFor(provider.windows, paces, state.error ?? state.data?.error ?? null, now);
    const identity = [provider.displayName, provider.accountEmail, provider.hostName].filter(Boolean).join(" · ");
    rows.push({ key, provider, windows: selected, status, title: [identity, status.detail, ...allWindows.map(entry => entry.detail)].join("\n") });
  }
  return rows;
}
