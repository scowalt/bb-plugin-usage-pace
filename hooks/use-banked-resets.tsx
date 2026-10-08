import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, UsageProvider } from "../server";
import { bankedResetsUnavailable, resetProviderName, supportsBankedResets, type BankedResets } from "../lib/banked-resets-contract";

export type BankedResetTarget = Pick<UsageProvider, "id" | "hostId" | "accountEmail">;
type ResetState = { data: BankedResets | null; loading: boolean };
const EMPTY: ResetState = { data: null, loading: true };
const Context = createContext<{ states: Record<string, ResetState>; refresh: () => void }>({ states: {}, refresh: () => {} });

export const bankedResetKey = (target: BankedResetTarget) => JSON.stringify([target.id, target.hostId, target.accountEmail]);
export const bankedResetSectionId = (target: BankedResetTarget) => `banked-resets-${encodeURIComponent(bankedResetKey(target))}`;

export function BankedResetsProvider({ providers, active, children }: {
  providers: UsageProvider[]; active: boolean; children: ReactNode;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const refreshRef = useRef(() => {});
  const [states, setStates] = useState<Record<string, ResetState>>({});
  const seen = new Set<string>();
  const targets = providers.filter(provider => {
    if (!supportsBankedResets(provider.id)) return false;
    if (provider.status !== "ok" || provider.accountEmail === null) return true;
    const account = JSON.stringify([provider.id, provider.accountEmail]);
    if (seen.has(account)) return false;
    seen.add(account);
    return true;
  }).map(({ id, hostId, accountEmail }) => ({ id, hostId, accountEmail }));
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
          if (!supportsBankedResets(target.id)) return;
          data = await rpcRef.current.call("getBankedResets", { hostId: target.hostId, providerId: target.id, force: forceRead });
          if ((data.status === "ok" || data.sessionReset) && target.accountEmail !== null && data.accountEmail?.toLowerCase() !== target.accountEmail.toLowerCase()) {
            data = bankedResetsUnavailable(`${resetProviderName(target.id)} account changed on this host. Refresh usage to check the current account.`);
          }
        } catch {
          data = bankedResetsUnavailable("Could not refresh banked resets. Try the refresh button again.");
        }
        if (!disposed) setStates(prior => ({ ...prior, [key]: { data, loading: false } }));
      }));
      pending = false;
      if (forceQueued && !disposed) void refresh();
    };
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
