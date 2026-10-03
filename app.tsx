// bb-plugin-usage-pace — frontend entry. Forked from Usage Bar by Dmitrii
// Kapustin (MIT); the pace math lives in lib/pace.ts.
//
// Surfaces (all fed by one store in lib/usage-store.ts):
//   1. A content script keeps an empty container as the first child of the
//      sidebar footer (above the icon row) and publishes it to the store.
//   2. An app overlay slot (always mounted) portals compact provider rows into
//      that container — provider icon · pace status · weekly/session used % — and
//      owns a centered dialog with the full breakdown, opened by clicking it.
import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  definePluginApp,
  experimental_ProviderIcon as ProviderIcon,
  useRealtime,
} from "@get-bb/plugin-sdk/app";
import type { UsageProvider, UsageWindow } from "./server";
import {
  formatReset,
  getBarHost,
  getUsageState,
  isOverlayOpen,
  refreshUsage,
  setBarHost,
  setOverlayOpen,
  subscribeBarHost,
  subscribeOverlay,
  subscribeUsage,
  toneColor,
  PLUGIN_ID,
  type UsageState,
} from "@/lib/usage-store";
import {
  describeRate,
  formatDuration,
  formatRunsOut,
  paceForWindows,
  toneForUsed,
  type Pace,
} from "@/lib/pace";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { mountCardPace } from "@/lib/card-pace";
import { compactUsageRows } from "@/lib/compact-usage";
import { BankedResetsBadge, BankedResetsSection } from "./banked-resets";
import { BankedResetsProvider, useRefreshBankedResets, type BankedResetTarget } from "./hooks/use-banked-resets";

const REFRESH_MS = 5 * 60_000;
const BAR_HOST_ID = "usage-pace-bar-host";
const FOOTER_SELECTOR = 'div[data-sidebar="footer"]';

// ---------------------------------------------------------------------------
// Content script: keep the container in the footer + refresh loop
// ---------------------------------------------------------------------------

function mountBarHost({ signal }: { signal: AbortSignal }) {
  const host = document.createElement("div");
  host.id = BAR_HOST_ID;
  host.style.minWidth = "0";

  const attach = () => {
    if (signal.aborted) return;
    const footer = document.querySelector(FOOTER_SELECTOR);
    if (footer === null) {
      host.remove();
      setBarHost(null);
      return;
    }
    const collapsed =
      footer.closest('[data-state="collapsed"]') !== null ||
      footer.getBoundingClientRect().width < 120;
    host.style.display = collapsed ? "none" : "block";
    if (host.parentElement !== footer || footer.firstChild !== host) {
      footer.insertBefore(host, footer.firstChild);
    }
    setBarHost(host);
  };
  attach();
  const observer = new MutationObserver(attach);
  observer.observe(document.body, { childList: true, subtree: true });
  const resize = new ResizeObserver(attach);
  resize.observe(document.body);

  let timer: number | null = null;
  const schedule = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    if (signal.aborted || document.visibilityState !== "visible") return;
    timer = window.setTimeout(() => {
      void refreshUsage({ signal });
      schedule();
    }, REFRESH_MS);
  };
  const onVisibility = () => {
    if (document.visibilityState === "visible") void refreshUsage({ signal });
    schedule();
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", onVisibility);
  void refreshUsage({ signal });
  schedule();

  return () => {
    observer.disconnect();
    resize.disconnect();
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("focus", onVisibility);
    if (timer !== null) window.clearTimeout(timer);
    setBarHost(null);
    host.remove();
  };
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

function useUsage(): UsageState {
  const state = useSyncExternalStore(subscribeUsage, getUsageState);
  useRealtime("usage-changed", () => {
    void refreshUsage();
  });
  return state;
}

/** Re-render once a minute so "resets in" stays fresh. */
function useMinuteTick() {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);
}

// ---------------------------------------------------------------------------
// Compact footer rows
// ---------------------------------------------------------------------------

function ProviderMark({
  provider,
  className,
}: {
  provider: UsageProvider;
  className?: string;
}) {
  return (
    <ProviderIcon
      providerKind="agent"
      provider={{
        id: provider.id,
        logoUrl: provider.logoUrl,
        icon: provider.icon,
        strings: { iconTint: provider.iconTint },
      }}
      className={cn("size-3.5 shrink-0", className)}
      aria-hidden
    />
  );
}

type TokenTotals = { day: number; month: number; timeZone: string; fetchedAt: string | null; error: string | null };

function useTokenTotals() {
  const [tokens, setTokens] = useState<TokenTotals | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const refresh = async () => {
      if (pending || document.visibilityState !== "visible") return;
      pending = true;
      try {
        const response = await fetch(`/api/v1/plugins/${PLUGIN_ID}/rpc/getTokens`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
          signal: controller.signal,
        });
        const body = await response.json();
        if (!response.ok || !body.ok) throw new Error("Token usage unavailable");
        if (!controller.signal.aborted) setTokens(body.result);
      } catch {
        if (!controller.signal.aborted) setTokens((prior) => ({
          day: 0, month: 0, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          fetchedAt: null, ...prior, error: "Could not refresh token usage",
        }));
      } finally { pending = false; }
    };
    const onVisible = () => { void refresh(); };
    void refresh();
    const timer = window.setInterval(onVisible, 60_000);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      controller.abort(); window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);
  return tokens;
}

export function UsageBar({ onOpen }: { onOpen: (target?: BankedResetTarget) => void }) {
  const state = useUsage();
  useMinuteTick();
  const rows = compactUsageRows(state);
  const open = () => onOpen();
  const empty = state.error || state.data?.error || state.data?.providers.some(provider => provider.status !== "ok" && provider.status !== "not_installed")
    ? "Usage unavailable"
    : state.loading ? "Loading usage…" : "No usage limits";
  return (
    <div
      data-bb-plugin={PLUGIN_ID}
      role="group"
      aria-label="BB usage limits"
      className="mb-1 flex w-full min-w-0 flex-col gap-0.5 py-1 text-[11px] leading-none text-sidebar-foreground"
    >
      {rows.length === 0 ? (
        <button type="button" onClick={open} aria-haspopup="dialog" className="truncate rounded px-1.5 py-1 text-left text-muted-foreground hover:bg-sidebar-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">{empty}</button>
      ) : rows.map(({ key, provider, windows, status, countdown, title }) => (
        <div key={key} className="flex min-w-0 items-center">
          <button
            type="button"
            onClick={open}
            aria-label={`${title}\nOpen usage details.`}
            aria-haspopup="dialog"
            className="grid min-w-0 grid-cols-[0.875rem_0.625rem_3.25rem_3.25rem] items-center gap-x-2 rounded px-1.5 py-1 text-left hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
            title={title}
          >
            <ProviderMark provider={provider} />
            <span
              aria-hidden="true"
              className="text-center text-[9px]"
              style={{ color: status.tone === null ? "var(--muted-foreground)" : status.tone === "ok" ? "var(--success, var(--primary, currentColor))" : toneColor(status.tone) }}
            >{status.glyph}</span>
            {windows.map(({ window, label, detail }, index) => (
              <span
                key={index}
                aria-hidden="true"
                title={`${status.detail}\n${detail}`}
                className={cn("flex min-w-0 items-center justify-between gap-1 whitespace-nowrap", label === "S" ? "col-start-4" : "col-start-3")}
              >
                <span className="truncate text-muted-foreground">{label}</span>
                <span className="shrink-0 font-semibold tabular-nums">{Math.round(window.usedPercent)}%</span>
              </span>
            ))}
            {countdown ? (
              <span
                aria-hidden="true"
                title={countdown.detail}
                className="col-span-2 col-start-3 row-start-2 mt-1 whitespace-nowrap text-muted-foreground tabular-nums"
              >{countdown.label}</span>
            ) : null}
          </button>
          {provider.id === "codex" ? <BankedResetsBadge target={provider} onOpen={() => onOpen(provider)} /> : null}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Centered dialog with the full breakdown
// ---------------------------------------------------------------------------

function WindowRow({ window, pace }: { window: UsageWindow; pace: Pace | null }) {
  const tone = pace?.tone ?? toneForUsed(window.usedPercent);
  const reset = formatReset(window.resetsAt);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate">{window.label}</span>
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {reset ? `resets in ${reset}` : ""}
        </span>
        <span
          className="w-10 shrink-0 text-right font-semibold tabular-nums"
          style={{ color: toneColor(tone) }}
        >
          {Math.round(window.usedPercent)}%
        </span>
      </div>
      <div className="relative h-1.5 rounded-full bg-border">
        <div
          className="h-full rounded-full transition-[width]"
          style={{
            width: `${Math.max(0, Math.min(100, window.usedPercent))}%`,
            background: toneColor(tone),
          }}
        />
        {pace !== null ? (
          <div
            aria-hidden="true"
            title="Even pace: the share of the window that has passed"
            className="absolute -top-0.5 h-2.5 w-0.5 -translate-x-1/2 rounded-full bg-foreground/70"
            style={{ left: `${pace.elapsedFraction * 100}%` }}
          />
        ) : null}
      </div>
      {pace !== null ? <PaceVerdict pace={pace} /> : null}
    </div>
  );
}

/** Rate details on the left; on the right, how long the quota is gone. */
function PaceVerdict({ pace }: { pace: Pace }) {
  const runsOut = formatRunsOut(pace, Date.now(), undefined, true);
  return (
    <div className="flex items-start justify-between gap-3 text-[11px] tabular-nums">
      <span className="min-w-0 text-muted-foreground">{describeRate(pace)}</span>
      {runsOut === null ? (
        pace.projectedPercent !== null ? <span className="shrink-0 text-muted-foreground">Lasts to reset</span> : null
      ) : (
        <span className="flex shrink-0 flex-col items-end text-right">
          <span className="font-semibold" style={{ color: toneColor(pace.tone) }}>
            {formatDuration(pace.lockoutMs)} without quota
          </span>
          <span className="text-muted-foreground">
            {runsOut === "now" ? "out now" : `runs out ${runsOut}`}
          </span>
        </span>
      )}
    </div>
  );
}

export function ProviderBlock({
  provider,
  showHost,
  showBankedResets,
  focusBankedResets,
}: {
  provider: UsageProvider;
  showHost: boolean;
  showBankedResets: boolean;
  focusBankedResets: boolean;
}) {
  const paces = paceForWindows(provider.windows);
  const subtitle = [
    provider.planLabel,
    provider.accountEmail,
    showHost ? provider.hostName : null,
  ]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(" · ");
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-2">
        <ProviderMark provider={provider} className="size-4" />
        <div className="flex min-w-0 flex-col">
          <span className="text-sm font-medium">{provider.displayName}</span>
          {subtitle ? (
            <span className="truncate text-[11px] text-muted-foreground">
              {subtitle}
            </span>
          ) : null}
        </div>
      </div>
      {provider.status === "ok" ? (
        provider.windows.length === 0 ? (
          <p className="text-xs text-muted-foreground">No limit windows reported.</p>
        ) : (
          provider.windows.map((window, index) => (
            <WindowRow key={window.label} window={window} pace={paces[index]!} />
          ))
        )
      ) : (
        <p className="text-xs text-muted-foreground">
          {provider.status === "not_installed"
            ? "CLI not installed on this host."
            : provider.status === "unauthenticated"
              ? "Not signed in. Sign in, then refresh."
              : provider.status === "expired"
                ? "Session expired. Sign in again, then refresh."
                : (provider.message ?? "Usage could not be loaded.")}
        </p>
      )}
      {showBankedResets && provider.id === "codex" ? <BankedResetsSection hostId={provider.hostId} hostName={provider.hostName} accountEmail={provider.accountEmail} focus={focusBankedResets} /> : null}
    </div>
  );
}

function UsageDialog({ tokens, bankedTarget }: { tokens: TokenTotals | null; bankedTarget: BankedResetTarget | null }) {
  const open = useSyncExternalStore(subscribeOverlay, isOverlayOpen);
  const refreshBankedResets = useRefreshBankedResets();
  const state = useUsage();
  useMinuteTick();
  // Same account on several hosts reports one quota: keep the first "ok"
  // entry per (provider, account); keep every non-ok entry (they are per host).
  const seenAccounts = new Set<string>();
  const providers = (state.data?.providers ?? []).filter((provider) => {
    if (provider.status !== "ok" || provider.accountEmail === null) return true;
    const key = `${provider.id}/${provider.accountEmail}`;
    if (seenAccounts.has(key)) return false;
    seenAccounts.add(key);
    return true;
  });
  const hostCount = new Set(providers.map((provider) => provider.hostId)).size;
  return (
    <Dialog open={open} onOpenChange={setOverlayOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Usage Pace
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Refresh usage"
              disabled={state.loading}
              onClick={() => {
                refreshBankedResets();
                void refreshUsage({ force: true });
              }}
            >
              <Icon
                name="ArrowReloadHorizontal"
                className={state.loading ? "size-4 animate-spin" : "size-4"}
              />
            </Button>
          </DialogTitle>
          <DialogDescription>
            {state.data
              ? `Updated ${new Date(state.data.fetchedAt).toLocaleTimeString()}`
              : "Loading usage…"}
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
          <section className="rounded-lg border p-3" aria-label="Token usage across BB">
            <h3 className="text-sm font-semibold">Tokens · across BB</h3>
            <dl className="mt-2 grid grid-cols-2 gap-3 text-sm tabular-nums">
              <div><dt className="text-muted-foreground">Today</dt><dd className="font-semibold">{tokens?.fetchedAt ? tokens.day.toLocaleString("en-US") : "—"}</dd></div>
              <div><dt className="text-muted-foreground">This month</dt><dd className="font-semibold">{tokens?.fetchedAt ? tokens.month.toLocaleString("en-US") : "—"}</dd></div>
            </dl>
            <p className="mt-2 text-[11px] text-muted-foreground">All projects, archived threads, and hidden agents. Includes usage reported by providers to BB. Cache and reasoning tokens are not counted again.</p>
            <p className="mt-1 text-[11px] text-muted-foreground">{tokens?.timeZone ?? ""}{tokens?.fetchedAt ? ` · Updated ${new Date(tokens.fetchedAt).toLocaleTimeString()}` : " · Loading…"}</p>
            {tokens?.error ? <p role="status" className="mt-1 text-xs text-muted-foreground">{tokens.error}</p> : null}
          </section>
          {providers.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {state.error ?? (state.loading ? "Loading…" : "No providers with usage reporting.")}
            </p>
          ) : (
            providers.map((provider) => (
              <ProviderBlock
                key={`${provider.hostId}/${provider.id}`}
                provider={provider}
                showHost={hostCount > 1}
                showBankedResets={open}
                focusBankedResets={bankedTarget?.hostId === provider.hostId && bankedTarget.accountEmail === provider.accountEmail}
              />
            ))
          )}
          {state.error !== null && providers.length > 0 ? (
            <p role="status" className="text-[11px] text-muted-foreground">
              Showing the last update. {state.error}
            </p>
          ) : null}
          {state.data?.error ? (
            <p role="status" className="text-[11px] text-muted-foreground">
              {state.data.error}
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Always-mounted overlay: portals the bar into the footer + owns the dialog. */
function UsageOverlay() {
  const tokens = useTokenTotals();
  const host = useSyncExternalStore(subscribeBarHost, getBarHost);
  // Off by default: the pace also shows in bb's own usage card (card-pace).
  const state = useUsage();
  const showStrip = state.data?.showStrip === true;
  const open = useSyncExternalStore(subscribeOverlay, isOverlayOpen);
  const [bankedTarget, setBankedTarget] = useState<BankedResetTarget | null>(null);
  const openDetails = (target?: BankedResetTarget) => {
    setBankedTarget(target ?? null);
    setOverlayOpen(true);
  };
  return (
    <BankedResetsProvider providers={state.data?.providers ?? []} active={(showStrip && host !== null) || open}>
      {host === null || !showStrip
        ? null
        : createPortal(<UsageBar onOpen={openDetails} />, host)}
      <UsageDialog tokens={tokens} bankedTarget={bankedTarget} />
    </BankedResetsProvider>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "usage", component: UsageOverlay });
  app.contentScripts.register({ id: "bar-host", mount: mountBarHost });
  app.contentScripts.register({ id: "card-pace", mount: mountCardPace });
});
