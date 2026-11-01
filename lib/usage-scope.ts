import type { UsageState } from "./usage-store";
import { hasSharedSource, onHost } from "./usage-accounts";
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
  const accounts = visible.filter(account =>
    hasSharedSource(account) || (!error && data.serverHostId && onHost(account, data.serverHostId)));
  return { ...state, data: { ...data, accounts, providers: accounts, pools: usagePools(accounts, data.fetchedAt), error: error ?? data.error } };
}
