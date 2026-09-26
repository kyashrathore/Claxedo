import { expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { launchPackagedClaxedo } from "../src/agent-claxedo-launcher"
import { readProcessTable, sameProcessIdentity, type ProcessSnapshot } from "../src/agent-process-family"

test("failed startup waits for owned descendants before disposable state is removed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "claxedo-launch-cleanup-"))
  const node = Bun.which("node")!
  const executable = path.join(root, "app")
  const parent = path.join(root, "parent.cjs")
  const pidFile = path.join(root, "child.json")
  let owned: ProcessSnapshot | undefined
  const unrelated = Bun.spawn([node, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" })
  try {
    await writeFile(parent, `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
      child.unref();
      fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ pid: child.pid }));
      process.on('SIGTERM', () => process.exit(0));
      setInterval(() => {}, 1000);
    `)
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    await writeFile(executable, `#!/bin/sh\nexec ${quote(node)} ${quote(parent)}\n`)
    await chmod(executable, 0o700)
    const launching = launchPackagedClaxedo({
      executable,
      isolatedProfilePath: path.join(root, "profile"),
      dataDirectory: path.join(root, "data"),
      readinessTargets: [],
      timeoutMs: 1_000,
    })
    // Attach the rejection handler immediately; the fixture deliberately never
    // exposes CDP, then leaves its child alive when the parent exits.
    const failure = launching.catch((error) => error as Error)
    const deadline = performance.now() + 3_000
    while (!owned && performance.now() < deadline) {
      const child = await readFile(pidFile, "utf8").then(JSON.parse).catch(() => undefined)
      if (child) owned = (await readProcessTable()).find((item) => item.pid === child.pid)
      if (!owned) await Bun.sleep(25)
    }
    expect(owned).toBeDefined()
    expect(await failure).toBeInstanceOf(Error)
    expect((await readProcessTable()).some((item) => sameProcessIdentity(item, owned!))).toBe(false)
    expect(unrelated.exitCode).toBeNull()
    await rm(root, { recursive: true })
  } finally {
    if (owned && (await readProcessTable()).some((item) => sameProcessIdentity(item, owned!))) process.kill(owned.pid, "SIGKILL")
    unrelated.kill("SIGKILL")
    await unrelated.exited
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
