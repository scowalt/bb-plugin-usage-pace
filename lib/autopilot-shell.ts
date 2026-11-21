import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { GEMINI_NEON, autopilotApplies, chooseExecution, geminiRunnability, type AutopilotRequest, type AutopilotSettings, type Runnability, type UsageReading } from "./autopilot";
import type { NewThreadExecutionChoice } from "./new-thread-seam";

export const COLD_WAIT_MS = 1_500;
export const RUNNABILITY_FRESH_MS = 5 * 60_000;
export const RUNNABILITY_STALE_MS = 30 * 60_000;
const RUNNABILITY_READ_MS = 10_000;

type AutopilotBb = Pick<BbPluginApi, "sdk" | "log">;

export interface AutopilotDeps {
  bb: AutopilotBb;
  signal: AbortSignal;
  settings: () => AutopilotSettings;
  readUsage: () => Promise<UsageReading | null>;
  now?: () => number;
}

export interface Autopilot {
  choose(request: Pick<AutopilotRequest, "origin" | "requested"> & { hostId: string | null }): Promise<NewThreadExecutionChoice | null>;
  warm(): void;
}

async function within<T>(ms: number, work: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>(resolve => {
    timer = setTimeout(resolve, ms, undefined);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createAutopilot(deps: AutopilotDeps): Autopilot {
  const { bb, signal } = deps;
  const now = deps.now ?? Date.now;
  const known = new Map<string, { at: number; value: Runnability }>();
  const loading = new Map<string, Promise<void>>();

  async function readRunnability(hostId: string): Promise<Runnability> {
    const read = AbortSignal.any([signal, AbortSignal.timeout(RUNNABILITY_READ_MS)]);
    const [providers, catalog] = await Promise.all([
      bb.sdk.providers.list({ hostId, signal: read }),
      bb.sdk.providers.models({ hostId, providerId: GEMINI_NEON.providerId, signal: read }),
    ]);
    return geminiRunnability(new Map(providers.map(entry => [entry.id, entry.available] as const)), catalog, "this machine");
  }

  function refresh(hostId: string): Promise<void> {
    const running = loading.get(hostId);
    if (running) return running;
    const started = readRunnability(hostId)
      .then(value => {
        known.set(hostId, { at: now(), value });
      })
      .catch((error: unknown) => {
        bb.log.warn(`autopilot could not check Gemini Neon on ${hostId}: ${messageOf(error)}`);
      })
      .finally(() => {
        loading.delete(hostId);
      });
    loading.set(hostId, started);
    return started;
  }

  async function runnabilityOn(hostId: string): Promise<Runnability> {
    const entry = known.get(hostId);
    const age = entry ? now() - entry.at : Infinity;
    if (age > RUNNABILITY_FRESH_MS) {
      const refreshing = refresh(hostId);
      if (age > RUNNABILITY_STALE_MS) await within(COLD_WAIT_MS, refreshing);
    }
    const current = known.get(hostId);
    if (current && now() - current.at <= RUNNABILITY_STALE_MS) return current.value;
    return { runnable: false, reason: "could not check Antigravity on this machine yet" };
  }

  async function resolveHost(requested: string | null): Promise<string | null> {
    if (requested !== null) return requested;
    try {
      return (await bb.sdk.system.config({ signal })).primaryHostId;
    } catch (error) {
      bb.log.warn(`autopilot could not find the primary machine: ${messageOf(error)}`);
      return null;
    }
  }

  async function onMachine(requested: string | null): Promise<{ hostId: string | null; gemini: Runnability }> {
    const hostId = await resolveHost(requested);
    if (hostId === null) return { hostId, gemini: { runnable: false, reason: "no machine to check Antigravity on" } };
    return { hostId, gemini: await runnabilityOn(hostId) };
  }

  return {
    async choose(request) {
      const settings = deps.settings();
      if (!autopilotApplies(settings, request)) return null;
      const [usage, machine] = await Promise.all([
        within(COLD_WAIT_MS, deps.readUsage().catch((error: unknown) => {
          bb.log.warn(`autopilot could not read usage: ${messageOf(error)}`);
          return null;
        })),
        within(COLD_WAIT_MS, onMachine(request.hostId)),
      ]);
      return chooseExecution({
        usage: usage ?? null,
        gemini: machine?.gemini ?? { runnable: false, reason: "could not check Antigravity in time" },
        hostId: machine?.hostId ?? request.hostId,
        settings,
        request,
        now: now(),
      });
    },
    warm() {
      void deps.readUsage().catch(() => null);
      void onMachine(null);
    },
  };
}
