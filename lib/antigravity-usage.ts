import { spawn, type ChildProcessByStdio } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type {
  ProviderHealthResult,
  ProviderUsage,
  ProviderUsageResult,
} from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import type { SourceUsage, SourceWindow } from "./usage-source-contract";

const DEFAULT_COMMAND = "agy";
const USAGE_ARGS = ["-p", "/usage", "--output-format", "json"];
const VERSION_ARGS = ["--version"];
const USAGE_TIMEOUT_MS = 15_000;
const VERSION_TIMEOUT_MS = 5_000;
const KILL_GRACE_MS = 2_000;
const STDERR_TAIL_CHARS = 4_096;
const CACHE_MS = 5 * 60_000;
const SIGNED_OUT_STDERR = /authentication required/i;
const AUTH_ERROR = /authenticat|log ?in|sign ?in|unauthori[sz]ed/i;

const empty = { plan: null, accountEmail: null, planLabel: null } as const;

type WindowSpec = { kind: SourceWindow["kind"]; suffix: string };

const WINDOWS = new Map<string, WindowSpec>([
  ["weekly", { kind: "weekly", suffix: "Weekly" }],
  ["5h", { kind: "five-hour", suffix: "5h" }],
]);

const envelopeSchema = z.object({
  status: z.string(),
  error: z.string().nullish(),
  command: z.object({ name: z.string(), data: z.unknown() }).nullish(),
});

const bucketSchema = z.object({
  id: z.string().min(1),
  window: z.string().min(1),
  remaining_fraction: z.number().finite(),
  reset_time: z.string().nullish(),
});

const reportSchema = z.object({
  groups: z.array(z.object({ name: z.string().trim().min(1), buckets: z.array(bucketSchema) })),
});

type Bucket = z.infer<typeof bucketSchema>;

function unavailable(status: "not_installed" | "unauthenticated"): SourceUsage {
  return { status, ...empty };
}

function failure(message: string): SourceUsage {
  return { status: "error", ...empty, message };
}

function usedPercent(remainingFraction: number): number {
  const used = Math.min(100, Math.max(0, (1 - remainingFraction) * 100));
  return Math.round(used * 100) / 100;
}

function isoOrNull(value: string | null | undefined): string | null {
  const at = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

function toWindow(group: string, bucket: Bucket): SourceWindow {
  const { kind, suffix }: WindowSpec = WINDOWS.get(bucket.window) ?? { kind: "custom", suffix: bucket.window };
  return {
    kind,
    id: bucket.id,
    label: `${group} · ${suffix}`,
    usedPercent: usedPercent(bucket.remaining_fraction),
    resetsAt: isoOrNull(bucket.reset_time),
    model: group,
    cost: null,
  };
}

export function parseAgyUsage(payload: unknown): SourceUsage {
  const envelope = envelopeSchema.safeParse(payload);
  if (!envelope.success) return failure("agy returned output that is not a usage report.");
  const { status, error, command } = envelope.data;
  if (status !== "SUCCESS") {
    if (error && AUTH_ERROR.test(error)) return unavailable("unauthenticated");
    return failure(error ? `agy reported an error: ${error}` : "agy reported an error.");
  }
  if (command?.name !== "usage") {
    return failure("agy did not run its /usage command, so its output was ignored.");
  }
  const report = reportSchema.safeParse(command.data);
  if (!report.success) return failure("agy returned a usage report in a shape this plugin does not know.");
  const windows = report.data.groups.flatMap((group) =>
    group.buckets.map((bucket) => toWindow(group.name, bucket)),
  );
  if (windows.length === 0) return failure("agy reported no usage limits.");
  return { status: "ok", ...empty, windows };
}

export type AgyRun =
  | { kind: "missing" }
  | { kind: "signed-out" }
  | { kind: "timed-out" }
  | { kind: "failed"; message: string }
  | { kind: "exited"; code: number | null; stdout: string };

export function usageFromRun(run: AgyRun): SourceUsage {
  switch (run.kind) {
    case "missing":
      return unavailable("not_installed");
    case "signed-out":
      return unavailable("unauthenticated");
    case "timed-out":
      return failure("agy did not answer in time.");
    case "failed":
      return failure(`agy could not be started: ${run.message}`);
    case "exited": {
      let payload: unknown;
      try {
        payload = JSON.parse(run.stdout);
      } catch {
        return failure(`agy printed output that is not JSON (exit code ${run.code ?? "none"}).`);
      }
      return parseAgyUsage(payload);
    }
  }
}

export type AgyRunOptions = {
  commands?: readonly string[];
  signal?: AbortSignal;
  timeoutMs?: number;
};

export function defaultAgyCommands(): string[] {
  return [DEFAULT_COMMAND, join(homedir(), ".local", "bin", "agy")];
}

function runCommand(
  command: string,
  args: readonly string[],
  { signal, timeoutMs }: { signal?: AbortSignal; timeoutMs: number },
): Promise<AgyRun> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    let done = false;
    let stdout = "";
    let stderr = "";
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (cause) {
      resolve({ kind: "failed", message: cause instanceof Error ? cause.message : String(cause) });
      return;
    }

    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    };
    const timer = setTimeout(() => {
      terminate();
      finish({ kind: "timed-out" });
    }, timeoutMs);
    const onAbort = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      terminate();
      reject(signal?.reason);
    };
    function finish(run: AgyRun) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(run);
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
      if (!SIGNED_OUT_STDERR.test(stderr)) return;
      terminate();
      finish({ kind: "signed-out" });
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ENOENT" ? { kind: "missing" } : { kind: "failed", message: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      finish({ kind: "exited", code, stdout });
    });
  });
}

async function runAgy(
  args: readonly string[],
  { commands = defaultAgyCommands(), signal, timeoutMs = USAGE_TIMEOUT_MS }: AgyRunOptions,
): Promise<AgyRun> {
  let run: AgyRun = { kind: "missing" };
  for (const command of commands) {
    run = await runCommand(command, args, { signal, timeoutMs });
    if (run.kind !== "missing") return run;
  }
  return run;
}

export function runAgyUsage(options: AgyRunOptions = {}): Promise<AgyRun> {
  return runAgy(USAGE_ARGS, options);
}

export async function readAgyUsage(options: AgyRunOptions = {}): Promise<SourceUsage> {
  return usageFromRun(await runAgyUsage(options));
}

export function cacheOkUsage(
  read: () => Promise<SourceUsage>,
  ttlMs: number = CACHE_MS,
  now: () => number = Date.now,
): () => Promise<SourceUsage> {
  let cached: { at: number; value: SourceUsage } | null = null;
  let inFlight: Promise<SourceUsage> | null = null;
  return () => {
    if (cached !== null && now() - cached.at < ttlMs) return Promise.resolve(cached.value);
    inFlight ??= read()
      .then((value) => {
        if (value.status === "ok") cached = { at: now(), value };
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}

export function toProviderUsage(usage: SourceUsage): ProviderUsage {
  switch (usage.status) {
    case "ok":
      return {
        status: "ok",
        accountEmail: null,
        planLabel: null,
        windows: usage.windows.map(({ label, usedPercent, resetsAt, kind, id }) => ({
          label,
          usedPercent,
          resetsAt,
          kind,
          id,
        })),
      };
    case "error":
      return { status: "error", message: usage.message, accountEmail: null, planLabel: null };
    default:
      return { status: usage.status };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function commandsFromOptions(providerOptions: unknown): string[] {
  const launchSpec = isRecord(providerOptions) ? providerOptions.acpLaunchSpec : undefined;
  const command = isRecord(launchSpec) ? launchSpec.command : undefined;
  return typeof command === "string" && command.trim() !== "" && command !== DEFAULT_COMMAND
    ? [command]
    : defaultAgyCommands();
}

const bridgeReaders = new Map<string, () => Promise<SourceUsage>>();

export async function readAntigravityUsage(providerOptions?: unknown): Promise<ProviderUsageResult> {
  const commands = commandsFromOptions(providerOptions);
  const key = commands.join("\0");
  let read = bridgeReaders.get(key);
  if (read === undefined) {
    read = cacheOkUsage(() => readAgyUsage({ commands }));
    bridgeReaders.set(key, read);
  }
  return { supported: true, usage: toProviderUsage(await read()) };
}

function versionFrom(output: string): string | null {
  return output.match(/\d+(?:\.\d+)+[\w.-]*/)?.[0] ?? null;
}

export async function readAntigravityHealth(providerOptions?: unknown): Promise<ProviderHealthResult> {
  const run = await runAgy(VERSION_ARGS, {
    commands: commandsFromOptions(providerOptions),
    timeoutMs: VERSION_TIMEOUT_MS,
  });
  const installedVersion = run.kind === "exited" && run.code === 0 ? versionFrom(run.stdout) : null;
  const status = run.kind === "missing" ? "not_installed" : installedVersion === null ? "unknown" : "ready";
  return {
    supported: true,
    health: {
      status,
      statusMessage: status === "unknown" ? "agy did not report its version." : null,
      accountEmail: null,
      planLabel: null,
      installedVersion,
      minimumSupportedVersion: null,
      canInstall: false,
      canUpdate: false,
      loginCommand: null,
    },
  };
}
