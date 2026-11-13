import { useEffect, useRef } from "react";
import { resetProviderName, type BankedResets, type SessionReset } from "./lib/banked-resets-contract";
import { bankedResetBadge } from "./lib/banked-reset-badge";
import { cn } from "./lib/utils";
import { formatResetShort } from "./lib/usage-store";
import { bankedResetSectionId, useBankedResets, type BankedResetTarget } from "./hooks/use-banked-resets";

const DAY = 86_400_000;
type Credit = BankedResets["credits"][number];

function countdown(expiresAt: string | null, now: number) {
  if (!expiresAt) return { text: "—", title: "Expiry not reported", soon: false };
  const date = new Date(expiresAt);
  const full = date.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  const ms = date.getTime() - now;
  if (ms <= 0) return { text: "Expired", title: `Expired ${full} — refresh`, soon: true };
  return { text: ms < 60_000 ? "<1m" : formatResetShort(expiresAt, now), title: `Expires ${full}`, soon: ms <= 7 * DAY };
}

function shortDate(expiresAt: string, now: number) {
  const date = new Date(expiresAt);
  const year = date.getFullYear() === new Date(now).getFullYear() ? undefined : "numeric";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year });
}

const meterNames: Record<string, string> = { five_hour: "session", seven_day: "weekly" };
function clearsLabel(clears: string[], usedPercent: Record<string, number> = {}) {
  const known = clears.filter(meter => Object.hasOwn(meterNames, meter));
  const shown = known.length ? known : clears;
  const weekly = clears.every(meter => meter.startsWith("seven_day"));
  const names = known.length ? known.map(meter => meterNames[meter])
    : [clears.length > 1 ? weekly ? "other weekly meters" : "other limits" : weekly ? "a second weekly meter" : "another limit"];
  const used = shown.length === 1 ? usedPercent[shown[0]!] : undefined;
  return {
    text: `Clears ${names.join(" + ")}${used === undefined ? "" : ` · ${Math.round(used)}% used`}`,
    title: `Claude meters: ${clears.map(meter => usedPercent[meter] === undefined ? meter : `${meter} ${Math.round(usedPercent[meter])}%`).join(", ")}`,
  };
}

function displayTitle(title: string) {
  const detail = title.slice(title.indexOf(": ") + 2);
  return title.includes(": ") && detail ? detail.charAt(0).toUpperCase() + detail.slice(1) : title;
}

function CreditRow({ credit, now }: { credit: Credit; now: number }) {
  const expiry = countdown(credit.expiresAt, now);
  const effect = credit.clears?.length ? clearsLabel(credit.clears, credit.usedPercent) : null;
  const notes = [credit.usableNow === false ? "Not redeemable now" : null, credit.supported === false ? "Not supported by plan" : null].filter(note => note !== null);
  return <li className="border-t border-border/60 py-1.5 text-xs first:border-t-0 first:pt-0">
    <div className="flex items-baseline justify-between gap-2">
      <span className="line-clamp-2 min-w-0" title={credit.title}>
        {displayTitle(credit.title)}{credit.remaining !== undefined && credit.remaining > 1 ? <span className="tabular-nums text-muted-foreground"> ×{credit.remaining}</span> : null}
      </span>
      <time dateTime={credit.expiresAt ?? undefined} title={expiry.title} className={cn("shrink-0 tabular-nums", expiry.soon ? "font-medium text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>{expiry.text}</time>
    </div>
    {effect || notes.length || credit.expiresAt ? <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground">
      {effect ? <span className="rounded bg-muted px-1" title={effect.title}>{effect.text}</span> : null}
      {notes.map(note => <span key={note}>{note}</span>)}
      {credit.expiresAt ? <span>{shortDate(credit.expiresAt, now)}</span> : null}
    </div> : null}
  </li>;
}

function SessionResetStatus({ data, now }: { data: SessionReset | undefined; now: number }) {
  const passed = data?.nextAvailableAt !== null && data?.nextAvailableAt !== undefined && Date.parse(data.nextAvailableAt) <= now;
  const reasons: Record<string, string> = {
    not_at_wall: "session limit not reached",
    weekly_limit: "weekly limit exhausted",
    no_weekly_limit: "no qualifying weekly limit",
    tier: "not offered for this plan",
    tenure: "account not eligible",
    extra_usage: "not offered with extra usage",
    other_experiment: "account not eligible",
  };
  const reason = data?.reason ? reasons[data.reason] : undefined;
  const status = passed ? "Availability time passed — refresh"
    : data?.availability === "available" ? "Available at last update"
    : data?.availability === "unavailable" ? reason ? `Not available · ${reason}` : "Not available now"
    : "Availability unknown";
  return <div role="group" className="mt-2 text-xs" aria-label="5-hour reset availability">
    <div className="flex flex-wrap items-baseline justify-between gap-x-2">
      <h4 title="Conditional session reset, separate from the saved balance.">5-hour reset</h4>
      <span className={data?.availability === "available" && !passed ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}>{status}</span>
    </div>
    {data?.nextAvailableAt && !passed ? <p className="mt-0.5 text-[11px] text-muted-foreground">Next availability reported: <time dateTime={data.nextAvailableAt}>{new Date(data.nextAvailableAt).toLocaleString()}</time></p> : null}
    {data?.availability === "available" && !passed ? <p className="mt-0.5 text-[11px] text-muted-foreground">Session only; the weekly limit still applies.</p> : null}
  </div>;
}

export function BankedResetsList({ data, loading, hostName, id, providerId = "codex", focusOnMount = false, now = Date.now() }: {
  data: BankedResets | null; loading: boolean; hostName: string; id?: string; providerId?: string; focusOnMount?: boolean; now?: number;
}) {
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!focusOnMount) return;
    const frame = window.requestAnimationFrame(() => {
      section.current?.scrollIntoView({ block: "nearest" });
      section.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusOnMount]);
  const expiredSinceRead = data?.credits.some(credit => credit.expiresAt !== null && Date.parse(credit.expiresAt) <= now);
  const claude = providerId === "claude-code";
  const label = claude ? "saved" : "banked";
  return (
    <section ref={section} id={id} tabIndex={-1} className="mt-1 border-t border-border pt-2" aria-label={claude ? "Claude limit resets" : "Codex banked resets"} aria-busy={loading}>
      <div className="flex flex-wrap items-baseline justify-between gap-1">
        <h3 className="text-xs font-semibold" title="Read-only saved-reset balance, separate from scheduled quota renewals. Redemption depends on provider eligibility.">{claude ? "Limit resets" : "Banked resets"}</h3>
        {data?.status === "ok" && data.availableCount !== null ? <span className="text-xs tabular-nums">{data.availableCount} {label}{expiredSinceRead ? " at last update" : ""}</span> : null}
      </div>
      {loading ? <p role="status" className="mt-2 text-xs text-muted-foreground">{data ? `Refreshing ${label} resets…` : `Loading ${label} resets…`}</p> : null}
      {data?.status === "ok" ? (
        data.credits.length === 0 ? (data.availableCount === 0 ? null : <p className="mt-2 text-xs">The provider did not return the reported reset details.</p>) : (
          <ul className="mt-2 flex flex-col">
            {data.credits.map(credit => <CreditRow key={credit.id} credit={credit} now={now} />)}
          </ul>
        )
      ) : null}
      {claude ? <SessionResetStatus data={data?.sessionReset} now={now} /> : null}
      <p className="mt-2 break-words text-[11px] text-muted-foreground">{data?.fetchedAt && data.accountEmail ? `${data.accountEmail} · ` : ""}{hostName}{data?.fetchedAt ? ` · Checked ${new Date(data.fetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}</p>
      {data?.message ? <p role="status" className="mt-2 text-xs text-muted-foreground">{data.message}</p> : null}
    </section>
  );
}

export function BankedResetsSection({ id, hostId, hostName, accountEmail, accountKey, focus = false }: BankedResetTarget & { hostName: string; focus?: boolean }) {
  const target = { id, hostId, accountEmail, accountKey };
  const { data, loading, applicable, hostName: inventoryHostName } = useBankedResets(target);
  if (!applicable) return null;
  return <BankedResetsList id={bankedResetSectionId(target)} providerId={id} data={data} loading={loading} hostName={inventoryHostName ?? hostName} focusOnMount={focus} />;
}

export function BankedResetsBadge({ target, onOpen, now = Date.now(), className }: {
  target: BankedResetTarget; onOpen: () => void; now?: number; className?: string;
}) {
  const { data, loading, applicable } = useBankedResets(target);
  if (!applicable) return null;
  const label = target.id === "claude-code" ? "saved" : "banked";
  const badge = bankedResetBadge(data, loading, now, label);
  const title = `${badge.title}\nOpen ${label}-reset details (read-only).`;
  return <button
    type="button"
    onClick={onOpen}
    title={title}
    aria-label={`${resetProviderName(target.id)}: ${title}`}
    aria-haspopup="dialog"
    className={cn("ml-1 inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 tabular-nums hover:bg-sidebar-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring", badge.warning ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground", badge.empty && "opacity-50", className)}
  ><span aria-hidden="true">↺</span><span>{badge.text}</span></button>;
}
