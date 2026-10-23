import type { UsageState } from "./usage-store";
import { hasSharedSource, onHost } from "./usage-accounts";
import { usagePools } from "./usage-pools";

export function usageForDisplay(state: UsageState): UsageState {
  const data = state.data;
  if (data?.serverOnly !== true) return state;
  const error = data.serverHostError ?? (data.serverHostId ? null : "Server host is not available. Check bb's machine connection, then refresh.");
  const accounts = (data.accounts ?? data.providers).filter(account =>
    hasSharedSource(account) || (!error && data.serverHostId && onHost(account, data.serverHostId)));
  return { ...state, data: { ...data, accounts, providers: accounts, pools: usagePools(accounts, data.fetchedAt), error: error ?? data.error } };
}
