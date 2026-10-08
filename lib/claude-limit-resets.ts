import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { bankedResetsUnavailable, type BankedResets, type SessionReset } from "./banked-resets-contract";

const exec = promisify(execFile);
const CACHE_MS = 5 * 60_000;
const timestamp = z.iso.datetime({ offset: true });
const authSchema = z.object({
  claudeAiOauth: z.object({
    accessToken: z.string().min(1),
    expiresAt: z.number().finite(),
    scopes: z.array(z.string()),
  }),
});
const profileSchema = z.object({
  account: z.object({ uuid: z.string().min(1), email: z.email() }),
  organization: z.object({ uuid: z.string().min(1) }),
});
const grantSchema = z.object({
  id: z.string().min(1).max(256),
  label: z.string().max(512).nullish(),
  resets_total: z.number().int().nonnegative().max(1000),
  resets_left: z.number().int().nonnegative().max(1000),
  starts_at: timestamp.nullish(),
  ends_at: timestamp.nullish(),
  clears: z.array(z.string().min(1).max(80)).max(32),
  paused: z.boolean(),
  usable_now: z.boolean().nullish(),
}).refine(grant => grant.resets_left <= grant.resets_total, "Invalid remaining balance");
const inventorySchema = z.object({
  eligible: z.literal(true),
  grants: z.array(grantSchema).max(200),
});
const sessionSchema = z.object({
  eligible: z.boolean(),
  ineligible_reason: z.string().max(80).nullable().optional(),
  arm: z.string().max(40).nullable().optional(),
  available: z.boolean(),
  next_available_at: timestamp.nullish(),
});
const usageSchema = z.object({ cedar_ember: z.unknown().optional(), juniper_tide: z.unknown().optional() });

function sessionStatus(raw: unknown): SessionReset {
  const unknown: SessionReset = { availability: "unknown", reason: null, nextAvailableAt: null };
  const parsed = sessionSchema.safeParse(raw);
  if (!parsed.success) return unknown;
  const value = parsed.data;
  const unavailableReasons = new Set(["not_at_wall", "weekly_limit", "no_weekly_limit", "tier", "tenure", "extra_usage", "other_experiment"]);
  if (!value.eligible) return unavailableReasons.has(value.ineligible_reason ?? "")
    ? { availability: "unavailable", reason: value.ineligible_reason ?? null, nextAvailableAt: null }
    : { ...unknown, reason: value.ineligible_reason ?? null };
  if (value.arm !== "reset") return unknown;
  return { availability: value.available ? "available" : "unavailable", reason: null, nextAvailableAt: value.next_available_at ?? null };
}

function normalize(raw: unknown, email: string, now: number): { data: BankedResets; until: number } {
  const usage = usageSchema.parse(raw);
  const sessionReset = sessionStatus(usage.juniper_tide);
  const parsed = inventorySchema.safeParse(usage.cedar_ember);
  const fetchedAt = new Date(now).toISOString();
  const nextAvailable = Date.parse(sessionReset.nextAvailableAt ?? "");
  let until = Math.min(now + CACHE_MS, nextAvailable > now ? nextAvailable : Infinity);
  if (!parsed.success) {
    return {
      data: {
        ...bankedResetsUnavailable("Claude did not report a readable saved-reset inventory. Access may be unavailable for this account or client; the balance is unknown.", "unsupported", email),
        fetchedAt, sessionReset,
      },
      until,
    };
  }
  const ids = new Set<string>();
  const credits: BankedResets["credits"] = [];
  for (const grant of parsed.data.grants) {
    if (ids.has(grant.id)) throw new Error("Duplicate reset grant");
    ids.add(grant.id);
    const start = grant.starts_at ? Date.parse(grant.starts_at) : -Infinity;
    const end = grant.ends_at ? Date.parse(grant.ends_at) : Infinity;
    if (end <= start) throw new Error("Invalid grant interval");
    if (grant.paused || grant.resets_left === 0 || end <= now) continue;
    if (start > now) { until = Math.min(until, start); continue; }
    until = Math.min(until, end);
    const session = grant.clears.includes("five_hour");
    const weekly = grant.clears.includes("seven_day");
    const scope = session && weekly ? "full" : session && grant.clears.length === 1 ? "five-hour" : "other";
    credits.push({
      id: grant.id, title: grant.label?.trim() || "Saved reset", remaining: grant.resets_left,
      expiresAt: grant.ends_at ? new Date(end).toISOString() : null, supported: null,
      scope, clears: grant.clears, usableNow: grant.usable_now ?? null,
    });
  }
  credits.sort((a, b) => (a.expiresAt ? Date.parse(a.expiresAt) : Infinity) - (b.expiresAt ? Date.parse(b.expiresAt) : Infinity) || a.id.localeCompare(b.id));
  return {
    data: { status: "ok", accountEmail: email, fetchedAt, availableCount: credits.reduce((sum, credit) => sum + credit.remaining!, 0), credits, sessionReset, message: null },
    until,
  };
}

async function readCredentials(signal?: AbortSignal): Promise<string> {
  const configured = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR;
  const directory = (configured || join(homedir(), ".claude")).normalize("NFC");
  if (process.platform === "darwin") {
    const suffix = configured ? `-${createHash("sha256").update(directory).digest("hex").slice(0, 8)}` : "";
    return (await exec("/usr/bin/security", ["find-generic-password", "-s", `Claude Code-credentials${suffix}`, "-w"], { signal, timeout: 3000, maxBuffer: 1024 * 1024 })).stdout;
  }
  return readFile(join(directory, ".credentials.json"), { encoding: "utf8", signal });
}

class ReadFailure extends Error {
  constructor(readonly status: "unauthenticated" | "unsupported" | "error", message: string) { super(message); }
}

async function readJson(path: string, token: string, userAgent: string, signal: AbortSignal, request: typeof fetch): Promise<unknown> {
  const response = await request(`https://api.anthropic.com${path}`, {
    method: "GET", redirect: "error", signal,
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json", "User-Agent": userAgent },
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 401) throw new ReadFailure("unauthenticated", "Claude login expired on this host. Refresh the Claude Code login, then try again.");
    throw new ReadFailure(response.status === 403 ? "unsupported" : "error", `Claude reset data unavailable (HTTP ${response.status}). Try refreshing later.`);
  }
  if (!response.body) throw new Error("Missing body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 1024 * 1024) throw new Error("Response too large");
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createClaudeLimitResetsReader(deps: {
  readAuth?: (signal?: AbortSignal) => Promise<string>;
  readVersion?: (signal?: AbortSignal) => Promise<string>;
  fetch?: typeof fetch;
  now?: () => number;
} = {}) {
  const readAuth = deps.readAuth ?? readCredentials;
  const readVersion = deps.readVersion ?? (async signal => (await exec("claude", ["--version"], { signal, timeout: 3000, maxBuffer: 4096 })).stdout);
  const request = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  let latestKey: string | null = null;
  let cache: { key: string; until: number; data: BankedResets } | null = null;
  let identity: { key: string; email: string } | null = null;
  let pending: { key: string; work: Promise<BankedResets> } | null = null;
  const invalidate = () => { latestKey = null; cache = null; identity = null; };

  return async function readClaudeLimitResets(force = false, signal?: AbortSignal): Promise<BankedResets> {
    if (signal?.aborted) return bankedResetsUnavailable("Claude reset read cancelled.");
    let auth: z.infer<typeof authSchema>["claudeAiOauth"];
    try { auth = authSchema.parse(JSON.parse(await readAuth(signal))).claudeAiOauth; }
    catch {
      invalidate();
      return bankedResetsUnavailable("Could not read a Claude subscription login on this host. Sign in with Claude Code on this host, then refresh.", "unauthenticated");
    }
    if (auth.expiresAt <= now()) {
      invalidate();
      return bankedResetsUnavailable("Claude login expired on this host. Refresh the Claude Code login, then try again.", "unauthenticated");
    }
    if (!auth.scopes.includes("user:profile")) {
      invalidate();
      return bankedResetsUnavailable("This Claude token cannot read subscription usage. Use a Claude Code subscription login with profile access.", "unsupported");
    }
    const key = createHash("sha256").update(auth.accessToken).digest("hex");
    if (latestKey !== key) { cache = null; identity = null; latestKey = key; }
    if (!force && cache?.key === key && cache.until > now()) return cache.data;
    if (pending?.key === key) return pending.work;
    cache = null;
    const work = (async (): Promise<BankedResets> => {
      const controller = new AbortController();
      const signals = [controller.signal, AbortSignal.timeout(15_000), ...(signal ? [signal] : [])];
      const readSignal = AbortSignal.any(signals);
      try {
        const version = /^(\d+\.\d+\.\d+)(?:\s|$)/u.exec((await readVersion(readSignal)).trim())?.[1];
        if (!version) throw new ReadFailure("unsupported", "Could not identify the installed Claude Code version. Update Claude Code on this host, then refresh.");
        const userAgent = `claude-cli/${version} (external, cli) bb-usage-pace`;
        const [raw, email] = await Promise.all([
          readJson("/api/oauth/usage?at_wall=1&skip_spend=1", auth.accessToken, userAgent, readSignal, request),
          identity?.key === key ? identity.email : readJson("/api/oauth/profile", auth.accessToken, userAgent, readSignal, request).then(value => profileSchema.parse(value).account.email),
        ]);
        const result = normalize(raw, email, now());
        if (!readSignal.aborted && latestKey === key) {
          identity = { key, email };
          cache = { key, ...result };
        }
        if (readSignal.aborted) return bankedResetsUnavailable("Claude reset read cancelled.");
        return result.data;
      } catch (error) {
        if (error instanceof ReadFailure) return bankedResetsUnavailable(error.message, error.status);
        return bankedResetsUnavailable("Could not read Claude resets. The request failed or Claude returned an unfamiliar response. Try refreshing.");
      } finally { controller.abort(); }
    })();
    pending = { key, work };
    try { return await work; }
    finally { if (pending?.work === work) pending = null; }
  };
}
