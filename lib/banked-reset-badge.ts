import type { BankedResets } from "./banked-resets-contract";
import { formatReset } from "./usage-store";

export function bankedResetBadge(data: BankedResets | null, loading: boolean, now = Date.now()) {
  const unknown = (title: string, text = "?") => ({ text, title, warning: false, empty: false });
  if (data === null) return unknown(loading ? "Loading banked resets…" : "Banked resets unavailable.", loading ? "…" : "?");
  if (data.status !== "ok" || data.availableCount === null) return unknown(data.message ?? "Banked resets unavailable.");
  const count = data.availableCount;
  const summary = `${count} banked reset${count === 1 ? "" : "s"}`;
  if (count === 0) return { text: "0", title: summary, warning: false, empty: true };
  const expiries = data.credits.flatMap(credit => credit.expiresAt && Number.isFinite(Date.parse(credit.expiresAt)) ? [Date.parse(credit.expiresAt)] : []);
  if (expiries.some(expiry => expiry <= now)) return unknown(`${summary} at last update; a reset has expired. Open details and refresh.`);
  const next = Math.min(...expiries);
  const incomplete = data.credits.length < count;
  const expiry = Number.isFinite(next)
    ? `${incomplete ? "Earliest reported expiry" : "Next expires"} in ${formatReset(new Date(next).toISOString(), now)} (${new Date(next).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}).`
    : "Expiry not reported.";
  return {
    text: String(count),
    title: `${summary} · ${expiry}${incomplete ? " Some reset details are unavailable." : ""}${loading ? " Refreshing…" : ""}`,
    warning: next - now <= 7 * 86_400_000,
    empty: false,
  };
}
