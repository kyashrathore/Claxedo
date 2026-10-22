import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { createHostRuntimeListener } from "@claxedo/host-serving/runtime"
import { hostServingState, setHostServing, stopHostServing } from "@claxedo/host-serving/serving"
import { volatileLaunchOwnership } from "@claxedo/process-ownership/launch"
import { testSessionCore } from "@claxedo/session-core/testing"
import { Pty } from "@claxedo/workspace-runtime"
import { withSessionCore } from "@claxedo/workspace-runtime/testing"
import { createFakeConnectControlPlane } from "../connect/fake-control-plane.test-support"
import type { HostDeps } from "../connect/host"
import { connectPaths, connectStateStore, EXIT_TIMEOUT_S } from "../connect/paths"
import { desktopDaemonDiscoveryFiles, desktopDaemonState } from "../connect/desktop-daemon"
import { connect, type ConnectDeps } from "./connect"

/**
 * Real terminals behave only under Node: under Bun a PTY's shell answers one
 * prompt and dies with SIGHUP, so this runs under `node --test` while the rest
 * of the command's tests run under Bun.
 */
void test("a SIGTERM with a terminal still open retires it, so the process can exit within the service manager's stop timeout", { skip: process.platform === "win32" }, async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-connect-pty-")))
  const cp = createFakeConnectControlPlane({ relayUrl: "http://127.0.0.1:9" })
  let stop: ((signal: string) => void) | undefined
  const host: HostDeps = {
    fetch: cp.fetch,
    createListener: () => createHostRuntimeListener({ hostname: "127.0.0.1", port: 0, drainTimeoutMs: 500 }),
    setServing: setHostServing,
    servingState: hostServingState,
    stopServing: stopHostServing,
    resolvePath: (target) => fs.realpath(target),
    setInterval: () => ({ cancel: () => undefined }),
    setTimeout: (fn, ms) => {
      const handle = setTimeout(fn, ms)
      return { cancel: () => clearTimeout(handle) }
    },
    onStopSignal: (fn) => {
      stop = fn
      return () => undefined
    },
    now: () => Date.now(),
    monotonicNow: () => performance.now(),
    sleep: async () => undefined,
    log: () => undefined,
    pid: process.pid,
  }
  const deps: ConnectDeps = {
    host,
    service: () => {
      throw new Error("no service in this test")
    },
    store: connectStateStore(home),
    paths: connectPaths(home),
    controlPlaneUrl: cp.url,
    displayName: "build-box",
    removeDir: (dir) => fs.rm(dir, { recursive: true, force: true }),
    desktopDaemon: () => desktopDaemonState({ files: desktopDaemonDiscoveryFiles({}, home) }),
  }
  const invitation = await cp.createInvitation({ displayName: "build-box", scope: { allowed_roots: [home] } })
  const tokenFile = path.join(home, "invite.txt")
  await fs.writeFile(tokenFile, `${invitation.token}\n`)

  try {
    const running = connect(["--token-file", tokenFile], deps)
    for (const deadline = Date.now() + 10_000; cp.beats().length === 0; await new Promise((resolve) => setTimeout(resolve, 20))) {
      assert.ok(Date.now() < deadline, "the first beat never arrived")
    }
    // A login shell ignores SIGTERM, which is what this stands in for.
    const terminal = await withSessionCore(testSessionCore(home), () =>
      Pty.create({ command: "/bin/sh", args: ["-c", "trap '' TERM; while :; do sleep 1; done"], cwd: home }, volatileLaunchOwnership()))
    assert.ok(terminal.pid > 0)

    const stoppedAt = performance.now()
    stop?.("SIGTERM")
    assert.equal(await running, 0)
    const elapsedMs = performance.now() - stoppedAt

    assert.deepEqual(Pty.list(), [])
    assert.throws(() => process.kill(terminal.pid, 0), { code: "ESRCH" }, "the terminal's shell outlived the connector")
    assert.ok(elapsedMs < EXIT_TIMEOUT_S * 1000, `stopped in ${Math.round(elapsedMs)} ms`)
  } finally {
    await Pty.dispose()
    await fs.rm(home, { recursive: true, force: true })
  }
})
