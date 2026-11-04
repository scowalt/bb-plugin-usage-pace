import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { bankedResetsUnavailable, type BankedResets } from "./banked-resets-contract";

const URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const CACHE_MS = 5 * 60_000;
const inventorySchema = z.object({
  available_count: z.number().int().nonnegative(),
  credits: z.array(z.object({
    id: z.string().min(1).max(256),
    status: z.string().max(64),
    title: z.string().max(256).nullish(),
    expires_at: z.string().max(80).refine(value => Number.isFinite(Date.parse(value))).nullish(),
    is_supported_by_plan: z.boolean().nullish(),
  })).max(1000),
});
const authSchema = z.object({
  auth_mode: z.string().optional(),
  OPENAI_API_KEY: z.string().nullish(),
  tokens: z.object({
    access_token: z.string().min(1),
    account_id: z.string().nullish(),
    id_token: z.string().nullish(),
  }).nullish(),
});
const claimsSchema = z.object({
  exp: z.number().optional(),
  email: z.string().optional(),
  "https://api.openai.com/profile": z.object({ email: z.string().optional() }).optional(),
  "https://api.openai.com/auth": z.object({
    chatgpt_account_id: z.string().optional(),
    chatgpt_account_is_fedramp: z.boolean().optional(),
  }).optional(),
});
function claims(token: string | null | undefined): z.infer<typeof claimsSchema> {
  try {
    return claimsSchema.parse(JSON.parse(Buffer.from(token?.split(".")[1] ?? "", "base64url").toString("utf8")));
  } catch { return {}; }
}

function normalize(raw: unknown, accountEmail: string | null, now: number): BankedResets {
  const inventory = inventorySchema.parse(raw);
  const ids = new Set<string>();
  const credits = inventory.credits
    .filter(credit => credit.status === "available" && (!credit.expires_at || Date.parse(credit.expires_at) > now))
    .map(credit => {
      if (ids.has(credit.id)) throw new Error("Duplicate credit");
      ids.add(credit.id);
      return {
        id: credit.id,
        title: credit.title?.trim() || "Reset credit",
        expiresAt: credit.expires_at ? new Date(credit.expires_at).toISOString() : null,
        supported: credit.is_supported_by_plan ?? null,
      };
    })
    .sort((a, b) => (a.expiresAt ? Date.parse(a.expiresAt) : Infinity) - (b.expiresAt ? Date.parse(b.expiresAt) : Infinity) || a.id.localeCompare(b.id));
  return {
    status: "ok", accountEmail, fetchedAt: new Date(now).toISOString(),
    availableCount: inventory.available_count, credits,
    message: credits.length === inventory.available_count ? null : "The reported count differs from the available list. Refresh to check again.",
  };
}

export const codexHome = () => process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
export const readCodexAuth = () => readFile(join(codexHome(), "auth.json"), "utf8");

export type CodexLogin =
  | { kind: "apiKey" }
  | { kind: "chatgpt"; token: string | null; accountId: string | null; email: string | null; expiresAtMs: number | null; fedramp: boolean };

export function parseCodexLogin(text: string): CodexLogin {
  const auth = authSchema.parse(JSON.parse(text));
  if (auth.auth_mode === "apikey" || auth.auth_mode === "apiKey" || (!auth.auth_mode && auth.OPENAI_API_KEY)) return { kind: "apiKey" };
  const token = auth.tokens?.access_token ?? null;
  const access = claims(token);
  const identity = claims(auth.tokens?.id_token);
  return {
    kind: "chatgpt", token,
    accountId: auth.tokens?.account_id || access["https://api.openai.com/auth"]?.chatgpt_account_id || identity["https://api.openai.com/auth"]?.chatgpt_account_id || null,
    email: access.email ?? access["https://api.openai.com/profile"]?.email ?? identity.email ?? null,
    expiresAtMs: access.exp === undefined ? null : access.exp * 1000,
    fedramp: access["https://api.openai.com/auth"]?.chatgpt_account_is_fedramp === true || identity["https://api.openai.com/auth"]?.chatgpt_account_is_fedramp === true,
  };
}

export function createBankedResetsReader(deps: {
  readAuth?: () => Promise<string>;
  fetch?: typeof fetch;
  now?: () => number;
} = {}) {
  const readAuth = deps.readAuth ?? readCodexAuth;
  const request = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  let cache: { key: string; until: number; data: BankedResets } | null = null;
  let pending: { key: string; work: Promise<BankedResets> } | null = null;

  return async function readBankedResets(force = false, signal?: AbortSignal): Promise<BankedResets> {
    let login: CodexLogin;
    try { login = parseCodexLogin(await readAuth()); }
    catch {
      cache = null;
      return bankedResetsUnavailable("Could not read a Codex ChatGPT login on this host. Sign in with Codex, then refresh.", "unauthenticated");
    }
    if (login.kind === "apiKey") {
      cache = null;
      return bankedResetsUnavailable("API-key logins do not have banked subscription resets.", "unsupported");
    }
    const { token, accountId, email } = login;
    if (!token || !accountId || (login.expiresAtMs !== null && login.expiresAtMs <= now())) {
      cache = null;
      return bankedResetsUnavailable("Codex login is missing or expired on this host. Sign in with Codex, then refresh.", "unauthenticated", email);
    }
    if (signal?.aborted) return bankedResetsUnavailable("Banked-reset read cancelled.", "error", email);
    const key = createHash("sha256").update(`${accountId}\0${token}`).digest("hex");
    if (!force && cache?.key === key && cache.until > now()) return cache.data;
    if (pending?.key === key) return pending.work;
    cache = null;
    const work = (async (): Promise<BankedResets> => {
      try {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${token}`, "chatgpt-account-id": accountId,
          Accept: "application/json", originator: "bb", "User-Agent": "bb-usage-pace",
        };
        if (login.fedramp) headers["X-OpenAI-Fedramp"] = "true";
        const timeout = AbortSignal.timeout(15_000);
        const response = await request(URL, {
          method: "GET", redirect: "error", headers,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (response.status === 401) return { ...bankedResetsUnavailable("Codex login expired. Sign in with Codex, then refresh.", "unauthenticated", email), accountKey: `openai:chatgpt:${accountId}` };
        if (!response.ok) return { ...bankedResetsUnavailable(`Banked resets unavailable (HTTP ${response.status}). This private Codex endpoint may be unavailable for this account.`, "error", email), accountKey: `openai:chatgpt:${accountId}` };
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
        const data = { ...normalize(JSON.parse(Buffer.concat(chunks).toString("utf8")), email, now()), accountKey: `openai:chatgpt:${accountId}` };
        const nextExpiry = Math.min(...data.credits.map(c => c.expiresAt ? Date.parse(c.expiresAt) : Infinity));
        cache = { key, until: Math.min(now() + CACHE_MS, nextExpiry), data };
        return data;
      } catch {
        return { ...bankedResetsUnavailable("Could not read banked resets. The request failed or Codex returned an unfamiliar response. Try refreshing.", "error", email), accountKey: `openai:chatgpt:${accountId}` };
      }
    })();
    pending = { key, work };
    try { return await work; }
    finally { if (pending?.work === work) pending = null; }
  };
}
