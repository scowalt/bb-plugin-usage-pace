import { describe, expect, it } from "vitest";
import { signedOutAccount } from "./signed-out-account";
import { mergeAccounts } from "./usage-accounts";
import { makeAccount } from "../tests/usage-fixtures";

const machine = { providerId: "claude-code", accountKey: "anthropic:account:b", hostId: "y", hostName: "stale-name", status: "expired" as const };
const source = { pluginId: "claude-accounts", displayName: "Claude Accounts" };

describe("signedOutAccount", () => {
  it("builds an empty, stale row on the live host with a host-scoped signed-out source", () => {
    expect(signedOutAccount(machine, source, "scott-beelink-ubuntu", undefined)).toMatchObject({
      id: "claude-code", displayName: "Claude Code", accountKey: "anthropic:account:b", status: "expired",
      stale: true, observedAt: null, windows: [], message: null, hostId: "y", hostName: "scott-beelink-ubuntu",
      hosts: [{ id: "y", name: "scott-beelink-ubuntu" }],
      sources: [{ pluginId: "claude-accounts", label: "Claude Accounts", resourceId: "signed-out:y", scope: { kind: "host", hostId: "y", hostName: "scott-beelink-ubuntu" } }],
    });
  });

  it("takes the provider's own name and mark when bb reports the provider", () => {
    const row = signedOutAccount(machine, source, "y", { id: "claude-code", displayName: "Claude Code (bb)", logoUrl: "/logo.svg" } as never);
    expect(row).toMatchObject({ displayName: "Claude Code (bb)", logoUrl: "/logo.svg" });
  });

  it("merges into a signed-in account as a signed-out machine and leaves its sources alone", () => {
    const healthy = makeAccount({ accountKey: "anthropic:account:b", hosts: [], sources: [{ pluginId: "claude-accounts", label: "Claude Accounts", resourceId: "b", scope: { kind: "shared" } }] });
    const [merged] = mergeAccounts([healthy, signedOutAccount({ ...machine, providerId: healthy.id }, source, "y", undefined)]);
    expect(merged!.signedOutHosts).toEqual([{ id: "y", name: "y", status: "expired" }]);
    expect(merged!.hosts).toEqual([]);
    expect(merged!.sources).toEqual(healthy.sources);
  });
});
