import { expect, it, vi } from "vitest";
import { createBankedResetsReader } from "./banked-resets";

const NOW = Date.parse("2026-10-23T12:00:00Z");
const token = `header.${Buffer.from(JSON.stringify({ exp: NOW / 1000 + 3600, email: "same@example.test" })).toString("base64url")}.signature`;
const credentials = (accountId: string) => JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: token, account_id: accountId } });

it("returns the Codex quota identity and invalidates inventory after a same-email account switch", async () => {
  let auth = credentials("account-a");
  const request = vi.fn<typeof fetch>(async () => Response.json({ available_count: 1, credits: [{ id: "credit", status: "available" }] }));
  const read = createBankedResetsReader({ readAuth: async () => auth, fetch: request, now: () => NOW });
  expect(await read()).toMatchObject({ status: "ok", accountEmail: "same@example.test", accountKey: "openai:chatgpt:account-a", availableCount: 1 });
  auth = credentials("account-b");
  expect(await read()).toMatchObject({ accountEmail: "same@example.test", accountKey: "openai:chatgpt:account-b" });
  expect(new Headers(request.mock.calls[1]?.[1]?.headers).get("chatgpt-account-id")).toBe("account-b");
  expect(request).toHaveBeenCalledTimes(2);
});

it("keeps an identified failed Codex inventory unknown instead of zero", async () => {
  const read = createBankedResetsReader({ readAuth: async () => credentials("account-a"), fetch: async () => new Response(null, { status: 403 }), now: () => NOW });
  expect(await read()).toMatchObject({ status: "error", accountKey: "openai:chatgpt:account-a", availableCount: null, credits: [] });
});

it("does not invent an account identity for an unread login", async () => {
  const read = createBankedResetsReader({ readAuth: async () => "{}", now: () => NOW });
  expect(await read()).toMatchObject({ status: "unauthenticated", availableCount: null });
  expect((await read()).accountKey).toBeUndefined();
});
