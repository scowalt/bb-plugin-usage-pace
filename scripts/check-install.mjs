// Exercise the source-build path used by BB Git installs, not just the
// checked-in bundles. A development checkout otherwise hides missing deps.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function checkInstall(root) {
  const isolated = await mkdtemp(join(tmpdir(), "usage-pace-install-check-"));
  const excluded = new Set([".git", "node_modules", ".claude", "bun.lock", "bun.lockb"]);
  const run = (command, args) => {
    const result = spawnSync(command, args, {
      cwd: isolated, stdio: "inherit", timeout: 180_000,
      env: { ...process.env, NODE_PATH: "" },
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${command} ${args.join(" ")} failed in a production-only checkout`);
  };
  try {
    // Retain dist/: Git installs may rebuild even when prebuilt files exist.
    await cp(root, isolated, {
      recursive: true,
      filter: path => !excluded.has(relative(root, path).split(/[\\/]/)[0]),
    });
    // For exact installer parity, point BB_INSTALL_NPM_CLI at the npm-cli.js
    // shipped with the BB version under test. Bun is the portable default.
    const npmCli = process.env.BB_INSTALL_NPM_CLI;
    if (npmCli) {
      run(process.execPath, [npmCli, "install", "--prefix", isolated, "--ignore-scripts", "--omit=dev", "--omit=optional", "--no-audit", "--no-fund"]);
    } else {
      run("bun", ["install", "--production", "--omit=optional", "--ignore-scripts", "--no-save"]);
    }
    const require = createRequire(join(isolated, "package.json"));
    for (const name of ["typescript", "vitest", "jsdom"]) {
      assert.throws(
        () => require.resolve(name),
        { code: "MODULE_NOT_FOUND" },
        `The source-build test must not have access to the ${name} devDependency`,
      );
    }
    // Provider-bridge imports need the pinned SDK runtime during host bundling.
    assert.ok(require.resolve("@get-bb/plugin-sdk/provider-bridge/acp"));
    run("bb", ["plugin", "build", isolated]);
    console.log("Production-only source build passed (no devDependencies, no provider requests).");
  } finally {
    await rm(isolated, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await checkInstall(resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..")));
}
