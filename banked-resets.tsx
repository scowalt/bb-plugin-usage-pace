import { useEffect, useRef } from "react";
import type { BankedResets } from "./lib/banked-resets-contract";
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

export function BankedResetsList({ data, loading, hostName, id, focusOnMount = false, now = Date.now() }: {
  data: BankedResets | null; loading: boolean; hostName: string; id?: string; focusOnMount?: boolean; now?: number;
}) {
  const section = useRef<HTMLElement>(null);
  // After the overlay's autofocus, on both desktop dialogs and compact drawers.
  useEffect(() => {
    if (!focusOnMount) return;
    const frame = window.requestAnimationFrame(() => {
      section.current?.scrollIntoView({ block: "nearest" });
      section.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusOnMount]);
  const expiredSinceRead = data?.credits.some(credit => credit.expiresAt !== null && Date.parse(credit.expiresAt) <= now);
  return (
    <section ref={section} id={id} tabIndex={-1} className="mt-1 border-t border-border pt-3" aria-label="Codex banked resets" aria-busy={loading}>
      <div className="flex flex-wrap items-baseline justify-between gap-1">
        <h3 className="text-xs font-semibold">Banked resets</h3>
        {data?.status === "ok" ? <span className="text-xs tabular-nums">{data.availableCount} banked{expiredSinceRead ? " at last update" : ""}</span> : null}
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">Saved resets, not scheduled quota resets. Read-only; not necessarily redeemable now.</p>
      {loading ? <p role="status" className="mt-2 text-xs text-muted-foreground">{data ? "Refreshing banked resets…" : "Loading banked resets…"}</p> : null}
      {data?.status === "ok" ? (
        <>
          {data.credits.length === 0 ? <p className="mt-2 text-xs">{data.availableCount === 0 ? "No banked resets available." : "The provider did not return the reported reset details."}</p> : (
            <ul className="mt-2 flex flex-col gap-2">
              {data.credits.map(credit => {
                const ms = credit.expiresAt ? Date.parse(credit.expiresAt) - now : Infinity;
                const soon = ms > 0 && ms <= 7 * DAY;
                return <li key={credit.id} className="rounded-md border border-border p-2 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-1">
                    <span className="font-medium">{credit.title}</span>
                    {soon ? <span className="font-medium text-amber-600 dark:text-amber-400">Expiring soon</span> : null}
                  </div>
                  {credit.expiresAt ? <>
                    <p className="mt-1 tabular-nums">{remaining(credit.expiresAt, now)}</p>
                    <time dateTime={credit.expiresAt} className="text-[11px] text-muted-foreground">{new Date(credit.expiresAt).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}</time>
                  </> : <p className="mt-1 text-muted-foreground">Expiry not reported</p>}
                  {credit.supported === false ? <p className="mt-1 text-muted-foreground">Not supported by current plan</p> : null}
                </li>;
              })}
            </ul>
          )}
          <p className="mt-2 break-words text-[11px] text-muted-foreground">{data.accountEmail ? `${data.accountEmail} · ` : ""}{hostName}{data.fetchedAt ? ` · Checked ${new Date(data.fetchedAt).toLocaleTimeString()}` : ""}</p>
        </>
      ) : null}
      {data?.message ? <p role="status" className="mt-2 text-xs text-muted-foreground">{data.message}</p> : null}
    </section>
  );
}

/** Both surfaces subscribe to the same host/account inventory. */
export function BankedResetsSection({ hostId, hostName, accountEmail, focus = false }: BankedResetTarget & { hostName: string; focus?: boolean }) {
  const { data, loading } = useBankedResets({ hostId, accountEmail });
  return <BankedResetsList id={bankedResetSectionId({ hostId, accountEmail })} data={data} loading={loading} hostName={hostName} focusOnMount={focus} />;
}

export function BankedResetsBadge({ target, onOpen, now = Date.now() }: {
  target: BankedResetTarget; onOpen: () => void; now?: number;
}) {
  const { data, loading } = useBankedResets(target);
  const badge = bankedResetBadge(data, loading, now);
  const title = `${badge.title}\nOpen banked-reset details (read-only).`;
  return <button
    type="button"
    onClick={onOpen}
    title={title}
    aria-label={`Codex: ${title}`}
    aria-haspopup="dialog"
    className={`ml-1 inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 tabular-nums hover:bg-sidebar-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${badge.warning ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}${badge.empty ? " opacity-50" : ""}`}
  ><span aria-hidden="true">↺</span><span>{badge.text}</span></button>;
}
