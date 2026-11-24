import type { UsageState } from "./usage-store";
import { hasSharedSource, onHost, signedOutOn } from "./usage-accounts";
import { displayedAccounts, usagePools } from "./usage-pools";

export function usageForDisplay(state: UsageState): UsageState {
  const data = state.data;
  if (!data) return state;
  const reported = data.accounts ?? data.providers;
  const visible = displayedAccounts(reported);
  if (data.serverOnly !== true) {
    return visible.length === reported.length ? state : {
      ...state, data: { ...data, accounts: visible, providers: visible, pools: usagePools(visible, data.fetchedAt) },
    };
  }
  const error = data.serverHostError ?? (data.serverHostId ? null : "Server host is not available. Check bb's machine connection, then refresh.");
  const serverHostId = error ? null : data.serverHostId ?? null;
  const accounts = visible.filter(account =>
    hasSharedSource(account) || (serverHostId !== null && (onHost(account, serverHostId) || signedOutOn(account, serverHostId))));
  return { ...state, data: { ...data, accounts, providers: accounts, pools: usagePools(accounts, data.fetchedAt), error: error ?? data.error } };
}
