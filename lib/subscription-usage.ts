import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { codexHome, parseCodexLogin, readCodexAuth } from "./banked-resets";
import { claudeConfigDir, readClaudeCredentials } from "./claude-limit-resets";
import type { SourceUsage, SourceWindow } from "./usage-source-contract";

export type HostUsage = { accountKey: string | null; usage: SourceUsage };

const TIMEOUT_MS = 15_000;
const empty = { plan: null, accountEmail: null, planLabel: null };
const percent = (value: number) => Math.min(100, Math.max(0, Math.round(Number.isFinite(value) ? value : 0)));
const iso = (value: string | null | undefined) => {
  const at = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
};
const exists = (path: string) => stat(path).then(() => true, () => false);
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

function window(index: number, label: string, kind: SourceWindow["kind"], usedPercent: number, resetsAt: string | null, model: string | null = null): SourceWindow {
  return { kind, id: `${index}:${label}`, label, usedPercent: percent(usedPercent), resetsAt, model, cost: null };
}

const claudeAuthSchema = z.object({
  claudeAiOauth: z.object({
    accessToken: z.string().min(1),
    expiresAt: z.number().nullish(),
    subscriptionType: z.string().nullish(),
    rateLimitTier: z.string().nullish(),
  }),
});
const claudeAccountSchema = z.object({
  oauthAccount: z.object({ emailAddress: z.string().nullish(), accountUuid: z.string().nullish() }).nullish(),
});
const claudeBucket = z.object({ utilization: z.number().nullish(), resets_at: z.string().nullish() });
const claudeLimit = z.object({
  kind: z.string(),
  scope: z.object({ model: z.object({ display_name: z.string().trim().min(1).nullish() }).nullish() }).nullish(),
  percent: z.number().nullish(),
  resets_at: z.string().nullish(),
});
const claudeUsageSchema = z.object({
  five_hour: claudeBucket.nullish(),
  seven_day: claudeBucket.nullish(),
  limits: z.array(claudeLimit.nullable().catch(null)).nullish().catch([]),
});

function parseClaudeAuth(text: string) {
  for (const candidate of [text.trim(), ...(/^(?:[0-9a-f]{2})+$/iu.test(text.trim()) ? [Buffer.from(text.trim(), "hex").toString("utf8")] : [])]) {
    try { return claudeAuthSchema.parse(JSON.parse(candidate)).claudeAiOauth; } catch {}
  }
  return null;
}

function claudePlan(auth: NonNullable<ReturnType<typeof parseClaudeAuth>>) {
  const multiplier = auth.rateLimitTier?.match(/max_(\d+)x/u)?.[1];
  const label = multiplier ? `Max (${multiplier}x)` : auth.subscriptionType ? auth.subscriptionType.charAt(0).toUpperCase() + auth.subscriptionType.slice(1) : null;
  return {
    planLabel: label,
    plan: auth.subscriptionType ? { id: auth.subscriptionType.toLowerCase(), multiplier: Number(multiplier) || null } : null,
  };
}

export function normalizeClaudeUsage(raw: unknown): SourceWindow[] | null {
  const parsed = claudeUsageSchema.safeParse(raw);
  if (!parsed.success) return null;
  const windows: SourceWindow[] = [];
  const bucket = (value: z.infer<typeof claudeBucket> | null | undefined, label: string, kind: SourceWindow["kind"]) => {
    if (value?.utilization != null) windows.push(window(windows.length, label, kind, value.utilization, iso(value.resets_at)));
  };
  bucket(parsed.data.five_hour, "Current session", "five-hour");
  bucket(parsed.data.seven_day, "Weekly limit", "weekly");
  const models = new Set<string>();
  for (const limit of parsed.data.limits ?? []) {
    const name = limit?.scope?.model?.display_name;
    if (limit?.kind !== "weekly_scoped" || name == null || limit.percent == null || models.has(name.toLowerCase())) continue;
    models.add(name.toLowerCase());
    windows.push(window(windows.length, name, "weekly", limit.percent, iso(limit.resets_at), name.toLowerCase()));
  }
  return windows;
}

export function createClaudeUsageReader(deps: {
  readAuth?: (signal?: AbortSignal) => Promise<string>;
  readAccount?: () => Promise<string>;
  installed?: () => Promise<boolean>;
  fetch?: typeof fetch;
  now?: () => number;
} = {}) {
  const readAuth = deps.readAuth ?? readClaudeCredentials;
  const readAccount = deps.readAccount ?? (() => {
    const configured = process.env.CLAUDE_CONFIG_DIR;
    return readFile(configured ? join(configured, ".claude.json") : join(homedir(), ".claude.json"), "utf8");
  });
  const installed = deps.installed ?? (() => exists(claudeConfigDir()));
  const request = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;

  return async function readClaudeUsage(signal?: AbortSignal): Promise<HostUsage> {
    const auth = await readAuth(signal).then(parseClaudeAuth, () => null);
    const account = await readAccount().then(text => claudeAccountSchema.parse(JSON.parse(text)).oauthAccount ?? null, () => null);
    const accountKey = account?.accountUuid ? `anthropic:account:${account.accountUuid}` : null;
    const accountEmail = account?.emailAddress ?? null;
    if (auth === null) return { accountKey: null, usage: { status: await installed() ? "unauthenticated" : "not_installed", ...empty } };
    const plan = claudePlan(auth);
    const identity = { ...plan, accountEmail };
    if (auth.expiresAt != null && now() >= auth.expiresAt) return { accountKey, usage: { status: "expired", ...identity } };
    try {
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      const response = await request("https://api.anthropic.com/api/oauth/usage", {
        method: "GET", redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { Authorization: `Bearer ${auth.accessToken}`, Accept: "application/json", "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.0" },
      });
      if (response.status === 401) return { accountKey, usage: { status: "expired", ...identity } };
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return { accountKey, usage: { status: "error", ...identity, message: response.status === 429
          ? "Anthropic temporarily throttled this usage check. This does not mean your Claude limit is exhausted. Try again later."
          : `Claude usage request failed (HTTP ${response.status}).` } };
      }
      const windows = normalizeClaudeUsage(await response.json());
      if (windows === null) return { accountKey, usage: { status: "error", ...identity, message: "Claude usage response was malformed." } };
      return { accountKey, usage: { status: "ok", ...identity, windows } };
    } catch (error) {
      return { accountKey, usage: { status: "error", ...identity, message: messageOf(error) } };
    }
  };
}

const codexWindowSchema = z.object({ used_percent: z.number(), reset_at: z.number().nullish(), limit_window_seconds: z.number().nullish() });
const codexUsageSchema = z.object({
  plan_type: z.string().nullish(),
  rate_limit: z.object({ primary_window: codexWindowSchema.nullish(), secondary_window: codexWindowSchema.nullish() }).nullish(),
});
const codexPlans: Record<string, string> = { free: "Free", go: "Go", plus: "Plus", pro: "Pro", team: "Team", business: "Business", education: "Education", edu: "Education", enterprise: "Enterprise" };

export function normalizeCodexUsage(raw: unknown): Pick<Extract<SourceUsage, { status: "ok" }>, "plan" | "planLabel" | "windows"> | null {
  const parsed = codexUsageSchema.safeParse(raw);
  if (!parsed.success) return null;
  const windows: SourceWindow[] = [];
  for (const [value, fallback] of [[parsed.data.rate_limit?.primary_window, "Current session"], [parsed.data.rate_limit?.secondary_window, "Weekly limit"]] as const) {
    if (!value) continue;
    const seconds = value.limit_window_seconds;
    const kind = seconds === 18_000 ? "five-hour" : seconds === 86_400 ? "daily" : seconds === 604_800 ? "weekly" : "custom";
    const resetsAt = value.reset_at == null || !Number.isFinite(value.reset_at) ? null : new Date(value.reset_at * 1000).toISOString();
    windows.push(window(windows.length, seconds === 604_800 ? "Weekly limit" : fallback, kind, value.used_percent, resetsAt));
  }
  const planType = parsed.data.plan_type;
  return {
    plan: planType ? { id: planType, multiplier: null } : null,
    planLabel: planType ? codexPlans[planType] ?? planType.charAt(0).toUpperCase() + planType.slice(1) : null,
    windows,
  };
}

export function createCodexUsageReader(deps: {
  readAuth?: () => Promise<string>;
  installed?: () => Promise<boolean>;
  fetch?: typeof fetch;
  now?: () => number;
} = {}) {
  const readAuth = deps.readAuth ?? readCodexAuth;
  const installed = deps.installed ?? (() => exists(codexHome()));
  const request = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;

  return async function readCodexUsage(signal?: AbortSignal): Promise<HostUsage> {
    let text: string;
    try { text = await readAuth(); }
    catch { return { accountKey: null, usage: { status: await installed() ? "unauthenticated" : "not_installed", ...empty } }; }
    let login: ReturnType<typeof parseCodexLogin>;
    try { login = parseCodexLogin(text); }
    catch { return { accountKey: null, usage: { status: "unauthenticated", ...empty } }; }
    if (login.kind === "apiKey") {
      return { accountKey: null, usage: { status: "error", ...empty, message: "Codex is authenticated with an API key, which has no subscription usage limits." } };
    }
    const accountKey = login.accountId ? `openai:chatgpt:${login.accountId}` : null;
    const identity = { ...empty, accountEmail: login.email };
    if (!login.token || !login.accountId) return { accountKey, usage: { status: "unauthenticated", ...identity } };
    if (login.expiresAtMs !== null && login.expiresAtMs <= now()) return { accountKey, usage: { status: "expired", ...identity } };
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${login.token}`, "chatgpt-account-id": login.accountId,
        originator: "bb", "User-Agent": "bb-usage-pace", Accept: "application/json",
      };
      if (login.fedramp) headers["X-OpenAI-Fedramp"] = "true";
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      const response = await request("https://chatgpt.com/backend-api/wham/usage", {
        method: "GET", redirect: "error", headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (response.status === 401) return { accountKey, usage: { status: "expired", ...identity } };
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return { accountKey, usage: { status: "error", ...identity, message: `Codex usage request failed (HTTP ${response.status}).` } };
      }
      const usage = normalizeCodexUsage(await response.json());
      if (usage === null) return { accountKey, usage: { status: "error", ...identity, message: "Codex usage response was malformed." } };
      return { accountKey, usage: { status: "ok", accountEmail: login.email, ...usage } };
    } catch (error) {
      return { accountKey, usage: { status: "error", ...identity, message: messageOf(error) } };
    }
  };
}
