// Verify the exact checkout to be tagged, then load its bundles without any
// plugin node_modules or real Codex credentials. Supply only the SDK runtime
// that BB provides to backend bundles. Never performs a provider request.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const json = async path => JSON.parse(await readFile(path, "utf8"));
const pkg = await json(join(root, "package.json"));
const lock = await json(join(root, "package-lock.json"));
assert.equal(lock.version, pkg.version);
assert.equal(lock.packages[""].version, pkg.version);
assert.deepEqual(lock.packages[""].engines, pkg.engines);
assert.deepEqual(lock.packages[""].dependencies, pkg.dependencies);
assert.deepEqual(lock.packages[""].devDependencies, pkg.devDependencies);
for (const entry of [pkg.bb.server, pkg.bb.app, pkg.bb.host]) {
  assert.ok((await stat(join(root, entry))).isFile(), `Missing source entry ${entry}`);
}
for (const bundle of ["server", "app", "host"]) {
  const meta = await json(join(root, "dist", `${bundle}.meta.json`));
  assert.equal(meta.pluginId, "usage-pace");
  assert.equal(meta.pluginVersion, pkg.version);
  assert.equal(meta.sdkVersion, pkg.devDependencies["@get-bb/plugin-sdk"]);
  const bytes = await readFile(join(root, "dist", `${bundle}.js`));
  assert.ok(bytes.length > 0);
  if (bundle === "host") {
    assert.equal(createHash("sha256").update(bytes).digest("hex"), meta.artifactDigest);
  }
}
assert.ok((await stat(join(root, "dist", "app.css"))).size > 0);
assert.equal((await json(join(root, "dist", "package.json"))).type, "module");

const isolated = await mkdtemp(join(tmpdir(), "usage-pace-release-runtime-"));
const previousCodexHome = process.env.CODEX_HOME;
// BB resolves this public runtime export itself; it is intentionally external
// in backend bundles, not a production npm dependency of the plugin.
const sdkUrl = process.env.BB_RELEASE_SDK_URL ?? import.meta.resolve("@get-bb/plugin-sdk");
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "@get-bb/plugin-sdk"
      ? { url: sdkUrl, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});
try {
  await cp(join(root, "dist"), join(isolated, "dist"), { recursive: true });
  process.env.CODEX_HOME = join(isolated, "no-codex-login");
  const server = await import(pathToFileURL(join(isolated, "dist", "server.js")).href);
  const host = await import(pathToFileURL(join(isolated, "dist", "host.js")).href);
  assert.equal(typeof server.default, "function");
  assert.deepEqual(Object.keys(server.rpcContract).sort(), ["getBankedResets", "getCardSettings", "getTokens", "getUsage"]);
  assert.equal(typeof host.experimental_providerBridge.handleLine, "function");
  assert.deepEqual(Object.keys(host.default.handlers), ["readBankedResets"]);
  const inventory = await host.default.handlers.readBankedResets({}, { signal: new AbortController().signal });
  assert.equal(inventory.status, "unauthenticated");
  assert.equal(inventory.availableCount, null);
  console.log(`Release ${pkg.version}: versions, metadata, host digest, and isolated backend/host loading (with BB's SDK runtime) verified. No provider requests made.`);
} finally {
  hooks.deregister();
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  await rm(isolated, { recursive: true, force: true });
}
