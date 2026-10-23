import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, UsageAccount } from "../server";
import { supportsBankedResets, type BankedResets } from "../lib/banked-resets-contract";

export type BankedResetTarget = Pick<UsageAccount, "id" | "hostId" | "accountEmail"> & { accountKey?: string | null };
type ResetReadTarget = BankedResetTarget & { hosts: UsageAccount["hosts"] };
type ResetState = { data: BankedResets | null; loading: boolean; applicable: boolean; hostName: string | null };
const EMPTY: ResetState = { data: null, loading: false, applicable: false, hostName: null };
const Context = createContext<{ states: Record<string, ResetState>; refresh: () => void }>({ states: {}, refresh: () => {} });

export const bankedResetKey = (target: BankedResetTarget) => JSON.stringify([target.id, target.accountKey ?? target.hostId]);
export const bankedResetSectionId = (target: BankedResetTarget) => `banked-resets-${encodeURIComponent(bankedResetKey(target))}`;

export function BankedResetsProvider({ providers, active, children, scopeHostId }: {
  providers: UsageAccount[]; active: boolean; children: ReactNode; scopeHostId?: string | null;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const refreshRef = useRef(() => {});
  const [states, setStates] = useState<Record<string, ResetState>>({});
  const seen = new Set<string>();
  const targets = providers.filter(provider => {
    if (!supportsBankedResets(provider.id) || provider.accountKey === null) return false;
    const account = bankedResetKey(provider);
    if (seen.has(account)) return false;
    seen.add(account);
    return true;
  }).map(({ id, hostId, hostName, hosts, accountEmail, accountKey }) => ({ id, hostId, accountEmail, accountKey,
    hosts: (hosts.length ? hosts : hostId ? [{ id: hostId, name: hostName }] : []).filter(host => scopeHostId === undefined || host.id === scopeHostId),
  })).filter(target => target.hosts.length > 0);
  const targetKey = JSON.stringify(targets);

  useEffect(() => {
    if (!active) return;
    const currentTargets: ResetReadTarget[] = JSON.parse(targetKey);
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
        setStates(prior => ({ ...prior, [key]: { data: prior[key]?.data ?? null, applicable: prior[key]?.applicable ?? false, hostName: prior[key]?.hostName ?? null, loading: true } }));
        let data: BankedResets | null = null;
        let hostName: string | null = null;
        for (const host of target.hosts) {
          try {
            if (!supportsBankedResets(target.id)) return;
            const inventory = await rpcRef.current.call("getBankedResets", { hostId: host.id, providerId: target.id, force: forceRead });
            if (target.accountKey && inventory.accountKey === target.accountKey) { data = inventory; hostName = host.name; break; }
          } catch {}
        }
        if (!disposed) setStates(prior => ({ ...prior, [key]: { data, hostName, loading: false, applicable: data !== null } }));
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
