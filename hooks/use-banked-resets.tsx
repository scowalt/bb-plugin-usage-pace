import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, UsageProvider } from "../server";
import { bankedResetsUnavailable, type BankedResets } from "../lib/banked-resets-contract";

export type BankedResetTarget = Pick<UsageProvider, "hostId" | "accountEmail">;
type ResetState = { data: BankedResets | null; loading: boolean };
const EMPTY: ResetState = { data: null, loading: true };
const Context = createContext<{ states: Record<string, ResetState>; refresh: () => void }>({ states: {}, refresh: () => {} });

export const bankedResetKey = (target: BankedResetTarget) => JSON.stringify([target.hostId, target.accountEmail]);
export const bankedResetSectionId = (target: BankedResetTarget) => `banked-resets-${encodeURIComponent(bankedResetKey(target))}`;

/** One inventory feed for the footer and dialog; independent of quota/pace reads. */
export function BankedResetsProvider({ providers, active, children }: {
  providers: UsageProvider[]; active: boolean; children: ReactNode;
}) {
  const rpc = useRpc<typeof rpcContract>();
  // The SDK need not return the same client object on every render.
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const refreshRef = useRef(() => {});
  const [states, setStates] = useState<Record<string, ResetState>>({});
  const seen = new Set<string>();
  const targets = providers.filter(provider => {
    if (provider.id !== "codex") return false;
    // Match the dialog's account deduplication: failed hosts stay separate.
    if (provider.status !== "ok" || provider.accountEmail === null) return true;
    if (seen.has(provider.accountEmail)) return false;
    seen.add(provider.accountEmail);
    return true;
  }).map(({ hostId, accountEmail }) => ({ hostId, accountEmail }));
  const targetKey = JSON.stringify(targets);

  useEffect(() => {
    if (!active) return;
    const currentTargets: BankedResetTarget[] = JSON.parse(targetKey);
    if (currentTargets.length === 0) return;
    let disposed = false;
    let pending = false;
    let forceQueued = false;
    const refresh = async (force = false): Promise<void> => {
      if (disposed) return;
      forceQueued ||= force;
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      const forceRead = forceQueued;
      forceQueued = false;
      await Promise.all(currentTargets.map(async target => {
        const key = bankedResetKey(target);
        setStates(prior => ({ ...prior, [key]: { data: prior[key]?.data ?? null, loading: true } }));
        let data: BankedResets;
        try {
          data = await rpcRef.current.call("getBankedResets", { hostId: target.hostId, force: forceRead });
          if (data.status === "ok" && target.accountEmail !== null && data.accountEmail?.toLowerCase() !== target.accountEmail.toLowerCase()) {
            data = bankedResetsUnavailable("Codex account changed on this host. Refresh usage to check the current account.");
          }
        } catch {
          data = bankedResetsUnavailable("Could not refresh banked resets. Try the refresh button again.");
        }
        if (!disposed) setStates(prior => ({ ...prior, [key]: { data, loading: false } }));
      }));
      pending = false;
      if (forceQueued && !disposed) void refresh();
    };
    // Discard inventories from a previous host/account selection.
    setStates({});
    refreshRef.current = () => { void refresh(true); };
    void refresh();
    const onVisible = () => { void refresh(); };
    const timer = window.setInterval(onVisible, 5 * 60_000);
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      refreshRef.current = () => {};
      window.clearInterval(timer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [targetKey, active]);

  return <Context.Provider value={{ states, refresh: () => refreshRef.current() }}>{children}</Context.Provider>;
}

export function useBankedResets(target: BankedResetTarget): ResetState {
  return useContext(Context).states[bankedResetKey(target)] ?? EMPTY;
}

export function useRefreshBankedResets(): () => void {
  return useContext(Context).refresh;
}
