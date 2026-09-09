// `node:test`'s `describe`/`test` return a promise the runner already owns: it
// settles when the suite finishes and reports failures through the runner
// rather than rejecting, so every registration below is deliberately `void`ed.
import { afterEach, beforeEach, describe, test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { WSContext } from "hono/ws"

/**
 * REAL @lydell/node-pty spawns — deliberately no module mock here, unlike
 * every sibling pty test. This is the falsifier for the native module actually
 * shipping and working: spawn a real /bin/sh through the real `Pty.create`
 * entrypoint, prove bytes flow both ways, resize the real pty, and see a clean
 * exit.
 *
 * Runs under `node --test` (see package.json), NOT under `bun test`: Bun's
 * runtime cannot service the pty's data socket (verified against both
 * node-pty@1.1.0 and @lydell/node-pty — the shell answers one prompt and dies
 * with SIGHUP), and every production entrypoint of this package runs under
 * Node. Skipped on Windows: CI for this package is POSIX, and the conpty path
 * needs a Windows host to mean anything.
 */

const posix = process.platform !== "win32"

const previousHistoryDir = process.env.WORKSPACE_RUNTIME_PTY_HISTORY_DIR

let tmpDir: string

function socket() {
  const sent: string[] = []
  return {
    ws: {
      readyState: 1,
      send: (data: unknown) => {
        if (typeof data === "string") sent.push(data)
      },
      close: () => {},
    } as unknown as WSContext,
    text: () => sent.join(""),
  }
}

async function waitFor(check: () => boolean, timeoutMs = 15_000) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pty-real-spawn-"))
  process.env.WORKSPACE_RUNTIME_PTY_HISTORY_DIR = path.join(tmpDir, "history")
})

afterEach(async () => {
  const { Pty } = await import("./index")
  await Pty.dispose()
  if (previousHistoryDir === undefined) delete process.env.WORKSPACE_RUNTIME_PTY_HISTORY_DIR
  else process.env.WORKSPACE_RUNTIME_PTY_HISTORY_DIR = previousHistoryDir
  await fs.rm(tmpDir, { recursive: true, force: true })
})

void describe("real pty spawn (no mocks)", { skip: !posix }, () => {
  void test("removing a terminal terminates its separate child process group without affecting a neighbor", { timeout: 30_000 }, async () => {
    const { Pty } = await import("./index")
    const launcher = path.join(tmpDir, "child-launcher.cjs")
    await fs.writeFile(launcher, `const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
console.log('CHILD_PID=' + child.pid);
setInterval(() => {}, 1000);
`)
    const target = await Pty.create({ command: process.execPath, args: [launcher], cwd: tmpDir })
    const neighbor = await Pty.create({ command: "/bin/sh", cwd: tmpDir })
    const targetClient = socket()
    const neighborClient = socket()
    assert.ok(Pty.connect(target.id, targetClient.ws))
    assert.ok(Pty.connect(neighbor.id, neighborClient.ws))
    let childPid: number | undefined
    const alive = (pid: number) => {
      try { process.kill(pid, 0); return true }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
        throw error
      }
    }
    try {
      await waitFor(() => /CHILD_PID=(\d+)/.test(targetClient.text()))
      childPid = Number(/CHILD_PID=(\d+)/.exec(targetClient.text())![1])
      assert.ok(alive(childPid))
      await Pty.remove(target.id)
      await waitFor(() => !alive(childPid!), 2_000)
      assert.equal(Pty.get(target.id), undefined)
      assert.equal(Pty.get(neighbor.id)?.pid, neighbor.pid)
      Pty.write(neighbor.id, "echo neighbor-$((40 + 2))\n")
      await waitFor(() => neighborClient.text().includes("neighbor-42"))
    } finally {
      // The regression intentionally exposes an orphan on unfixed builds.
      if (childPid && alive(childPid)) process.kill(-childPid, "SIGKILL")
    }
  })

  void test("spawns /bin/sh, echoes a command, resizes, and exits cleanly", { timeout: 30_000 }, async () => {
    const { Pty } = await import("./index")
    const info = await Pty.create({ command: "/bin/sh", cwd: tmpDir, title: "real" })
    assert.equal(info.status, "running")
    assert.ok(info.pid > 0)

    const client = socket()
    const handlers = Pty.connect(info.id, client.ws)
    assert.ok(handlers)

    // Output written by the real shell must arrive at the subscriber. The
    // arithmetic expansion doubles as a mock detector: an echo of the typed
    // input would still contain "$((40 + 2))", never the expanded result.
    Pty.write(info.id, "echo real-pty-$((40 + 2))\n")
    await waitFor(() => client.text().includes("real-pty-42"))

    // Resize reaches the real pty: the shell answers `stty size` with the new
    // geometry, so the dimensions round-trip through the native layer.
    Pty.resize(info.id, 120, 40)
    Pty.write(info.id, "stty size\n")
    await waitFor(() => client.text().includes("40 120"))

    // Both public resize routes must preserve their ordering with input while
    // detached. Reattach to the same real process and read its actual geometry.
    handlers.onClose()
    await Pty.update(info.id, { size: { cols: 93, rows: 31 } })
    Pty.resize(info.id, 107, 37)
    Pty.write(info.id, "printf 'QUEUED_SIZE:'; stty size\n")
    const reattached = socket()
    assert.ok(Pty.connect(info.id, reattached.ws))
    await waitFor(() => reattached.text().includes("QUEUED_SIZE:37 107"))

    // Clean exit propagates from the native onExit into session state.
    Pty.write(info.id, "exit\n")
    await waitFor(() => Pty.get(info.id)?.status === "exited")
  })
})
