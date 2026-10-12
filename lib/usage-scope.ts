import type { UsageState } from "./usage-store";

export function usageForDisplay(state: UsageState): UsageState {
  const data = state.data;
  if (data?.serverOnly !== true) return state;
  const error = data.serverHostError ?? (data.serverHostId ? null : "Server host is not available. Check bb's machine connection, then refresh.");
  const providers = error || !data.serverHostId
    ? []
    : data.providers.filter(provider => provider.hostId === data.serverHostId);
  return { ...state, data: { ...data, providers, error } };
}
