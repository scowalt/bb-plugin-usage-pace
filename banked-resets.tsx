import { useEffect, useRef } from "react";
import { resetProviderName, type BankedResets, type SessionReset } from "./lib/banked-resets-contract";
import { bankedResetBadge } from "./lib/banked-reset-badge";
import { bankedResetSectionId, useBankedResets, type BankedResetTarget } from "./hooks/use-banked-resets";

const DAY = 86_400_000;
function remaining(expiresAt: string, now: number): string {
  const ms = Date.parse(expiresAt) - now;
  if (ms <= 0) return "Expired since last update — refresh";
  if (ms < 60_000) return "Expires in less than a minute";
  if (ms < 3_600_000) return `Expires in ${Math.ceil(ms / 60_000)}m`;
  if (ms < DAY) return `Expires in ${Math.ceil(ms / 3_600_000)}h`;
  return `Expires in ${Math.floor(ms / DAY)}d ${Math.floor(ms % DAY / 3_600_000)}h`;
}

function SessionResetStatus({ data, now }: { data: SessionReset | undefined; now: number }) {
  const passed = data?.nextAvailableAt !== null && data?.nextAvailableAt !== undefined && Date.parse(data.nextAvailableAt) <= now;
  const reasons: Record<string, string> = {
    not_at_wall: "The session limit has not been reached. Eligibility will be checked again later.",
    weekly_limit: "The weekly limit is exhausted.",
    no_weekly_limit: "No qualifying weekly limit was reported.",
    tier: "Not offered for the current plan.",
    tenure: "Account eligibility requirements are not met.",
    extra_usage: "Not offered with the current extra-usage settings.",
    other_experiment: "Not offered for this account's current eligibility.",
  };
  return <div role="group" className="mt-3 rounded-md border border-border p-2 text-xs" aria-label="5-hour reset availability">
    <h4 className="font-medium">5-hour reset availability</h4>
    <p className="mt-1">{passed ? "Availability time passed — refresh" : data?.availability === "available" ? "Available at last update" : data?.availability === "unavailable" ? "Not available now" : "Availability unknown"}</p>
    {data?.reason && reasons[data.reason] ? <p className="mt-1 text-muted-foreground">{reasons[data.reason]}</p> : null}
    {data?.nextAvailableAt && !passed ? <p className="mt-1 text-muted-foreground">Next availability reported: <time dateTime={data.nextAvailableAt}>{new Date(data.nextAvailableAt).toLocaleString()}</time></p> : null}
    <p className="mt-1 text-[11px] text-muted-foreground">Conditional session-only reset; the weekly limit still applies. Not included in saved-reset counts.</p>
  </div>;
}

const scopeLabels = { full: "Full reset", "five-hour": "5-hour reset", other: "Other saved reset" };
const windowLabels: Record<string, string> = { five_hour: "5-hour session", seven_day: "weekly", seven_day_overage_included: "weekly included usage" };

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
    <section ref={section} id={id} tabIndex={-1} className="mt-1 border-t border-border pt-3" aria-label={claude ? "Claude limit resets" : "Codex banked resets"} aria-busy={loading}>
      <div className="flex flex-wrap items-baseline justify-between gap-1">
        <h3 className="text-xs font-semibold">{claude ? "Limit resets" : "Banked resets"}</h3>
        {data?.status === "ok" && data.availableCount !== null ? <span className="text-xs tabular-nums">{data.availableCount} {label}{expiredSinceRead ? " at last update" : ""}</span> : null}
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">Saved resets, not scheduled quota resets. Read-only; not necessarily redeemable now.</p>
      {loading ? <p role="status" className="mt-2 text-xs text-muted-foreground">{data ? `Refreshing ${label} resets…` : `Loading ${label} resets…`}</p> : null}
      {data?.status === "ok" ? (
        <>
          {data.credits.length === 0 ? <p className="mt-2 text-xs">{data.availableCount === 0 ? `No ${label} resets available.` : "The provider did not return the reported reset details."}</p> : (
            <ul className="mt-2 flex flex-col gap-2">
              {data.credits.map(credit => {
                const ms = credit.expiresAt ? Date.parse(credit.expiresAt) - now : Infinity;
                const soon = ms > 0 && ms <= 7 * DAY;
                return <li key={credit.id} className="rounded-md border border-border p-2 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-1">
                    <span className="font-medium">{credit.scope ? scopeLabels[credit.scope] : credit.title}{credit.remaining !== undefined ? ` · ${credit.remaining} saved` : ""}</span>
                    {soon ? <span className="font-medium text-amber-600 dark:text-amber-400">Expiring soon</span> : null}
                  </div>
                  {credit.scope ? <p className="mt-1 text-muted-foreground">{credit.title}</p> : null}
                  {credit.clears?.length ? <p className="mt-1 text-muted-foreground">Affects: {credit.clears.map(window => windowLabels[window] ?? window.replaceAll("_", " ")).join(", ")}</p> : null}
                  {credit.usableNow === false ? <p className="mt-1 text-muted-foreground">Not currently redeemable</p> : null}
                  {credit.expiresAt ? <>
                    <p className="mt-1 tabular-nums">{remaining(credit.expiresAt, now)}</p>
                    <time dateTime={credit.expiresAt} className="text-[11px] text-muted-foreground">{new Date(credit.expiresAt).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}</time>
                  </> : <p className="mt-1 text-muted-foreground">Expiry not reported</p>}
                  {credit.supported === false ? <p className="mt-1 text-muted-foreground">Not supported by current plan</p> : null}
                </li>;
              })}
            </ul>
          )}
        </>
      ) : null}
      {claude ? <SessionResetStatus data={data?.sessionReset} now={now} /> : null}
      <p className="mt-2 break-words text-[11px] text-muted-foreground">{data?.fetchedAt && data.accountEmail ? `${data.accountEmail} · ` : ""}{hostName}{data?.fetchedAt ? ` · Checked ${new Date(data.fetchedAt).toLocaleTimeString()}` : ""}</p>
      {data?.message ? <p role="status" className="mt-2 text-xs text-muted-foreground">{data.message}</p> : null}
    </section>
  );
}

export function BankedResetsSection({ id, hostId, hostName, accountEmail, focus = false }: BankedResetTarget & { hostName: string; focus?: boolean }) {
  const target = { id, hostId, accountEmail };
  const { data, loading } = useBankedResets(target);
  return <BankedResetsList id={bankedResetSectionId(target)} providerId={id} data={data} loading={loading} hostName={hostName} focusOnMount={focus} />;
}

export function BankedResetsBadge({ target, onOpen, now = Date.now() }: {
  target: BankedResetTarget; onOpen: () => void; now?: number;
}) {
  const { data, loading } = useBankedResets(target);
  const label = target.id === "claude-code" ? "saved" : "banked";
  const badge = bankedResetBadge(data, loading, now, label);
  const title = `${badge.title}\nOpen ${label}-reset details (read-only).`;
  return <button
    type="button"
    onClick={onOpen}
    title={title}
    aria-label={`${resetProviderName(target.id)}: ${title}`}
    aria-haspopup="dialog"
    className={`ml-1 inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 tabular-nums hover:bg-sidebar-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${badge.warning ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}${badge.empty ? " opacity-50" : ""}`}
  ><span aria-hidden="true">↺</span><span>{badge.text}</span></button>;
}
