import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE_ARGS_ONLY = `[ "$*" = "-p /usage --output-format json" ] || { echo "unexpected arguments: $*" >&2; exit 2; }`;

export function agyFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitUntilDead(pid: number, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isProcessAlive(pid);
}

export function createFakeAgy() {
  const dir = mkdtempSync(join(tmpdir(), "fake-agy-"));
  let count = 0;
  const next = (prefix: string) => join(dir, `${prefix}-${count++}`);

  function executable(body: string): string {
    const path = next("agy");
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  function counted(body: string) {
    const counterFile = next("runs");
    writeFileSync(counterFile, "");
    const command = executable(`echo run >> '${counterFile}'\n${body}`);
    return {
      command,
      runs: () => readFileSync(counterFile, "utf8").split("\n").filter(Boolean).length,
    };
  }

  function printing(stdout: string) {
    const outFile = next("out");
    writeFileSync(outFile, stdout);
    return counted(`${USAGE_ARGS_ONLY}\ncat '${outFile}'`);
  }

  function withPidFile(body: string) {
    const pidFile = next("pid");
    const run = counted(`echo $$ > '${pidFile}'\n${body}`);
    return { ...run, pid: () => Number(readFileSync(pidFile, "utf8").trim()) };
  }

  return {
    dir,
    printing,
    printingFixture: (name: string) => printing(agyFixture(name)),
    version: (output: string) => executable(`[ "$*" = "--version" ] || exit 2\nprintf '%s\\n' '${output}'`),
    signedOut: () =>
      withPidFile(`echo 'Authentication required. Please visit the URL to log in:' >&2\nexec sleep 30`),
    hanging: () => withPidFile(`exec sleep 30`),
    missing: () => join(dir, "does-not-exist"),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}
