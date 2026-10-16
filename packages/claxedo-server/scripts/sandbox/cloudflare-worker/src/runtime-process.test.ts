import { describe, expect, test } from "vitest"
import { ensureRuntimeProcess, runtimeServing, type RuntimeHost, type RuntimeLaunch } from "./runtime-process"
import { fakeContainer } from "./test-support/fake-container"

const COMMAND = "/usr/local/bin/workspace-runtime"
const PORT = 2593
const MINUTE = 60_000

function host() {
  const { container, state } = fakeContainer()
  container.start({ image: container.images.runtime, entrypoint: ["/usr/bin/tini", "--", "sleep", "infinity"], enableInternet: true, instance: "standard-1" })
  let recorded: RuntimeLaunch | undefined
  let clock = 1_000_000
  let ids = 0
  const runtime: RuntimeHost = {
    container,
    imageEnv: { PATH: "/root/.local/bin:/usr/local/bin:/usr/bin", AMP_SKIP_UPDATE_CHECK: "1" },
    launches: {
      get: async () => recorded && { ...recorded },
      put: async (launch) => {
        recorded = { ...launch }
      },
      delete: async () => {
        recorded = undefined
      },
    },
    now: () => clock,
    newId: () => `launch-${++ids}`,
    pause: async (ms) => {
      clock += ms
    },
  }
  return {
    runtime,
    state,
    recorded: () => recorded,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

describe("workspace-runtime process", () => {
  test("a first ensure launches the runtime in /run with the recorded image environment, the interception trust and the boot env, and records it ready", async () => {
    const h = host()
    expect(await ensureRuntimeProcess(h.runtime, COMMAND, { WORKSPACE_RUNTIME_PORT: "2593", PATH: "/custom" }, PORT, { reuseRunning: true })).toEqual({ state: "ready" })
    const [launch] = h.state.launches.values()
    expect(launch).toMatchObject({
      dir: "/run/claxedo-runtime/launch-1",
      command: COMMAND,
      cwd: "/workspace",
      env: {
        AMP_SKIP_UPDATE_CHECK: "1",
        NODE_EXTRA_CA_CERTS: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
        REQUESTS_CA_BUNDLE: "/etc/ssl/certs/ca-certificates.crt",
        WORKSPACE_RUNTIME_PORT: "2593",
        WORKSPACE_RUNTIME_OPERATOR_LOG: "/run/claxedo-runtime/launch-1/operator.log",
        PATH: "/custom",
      },
    })
    expect(h.recorded()).toEqual({ id: "launch-1", launchedAt: 1_000_000, ready: true })
  })

  test("a launch the host refuses never starts, so no runtime gets the boot env", async () => {
    const h = host()
    h.runtime.beforeLaunch = async () => {
      throw new Error("refused")
    }
    await expect(ensureRuntimeProcess(h.runtime, COMMAND, { SECRET: "s" }, PORT, { reuseRunning: true })).rejects.toThrow("refused")
    expect(h.state.launches.size).toBe(0)
    expect(h.recorded()).toBeUndefined()
  })

  test("a running runtime is left alone when the caller says its env is unchanged", async () => {
    const h = host()
    await ensureRuntimeProcess(h.runtime, COMMAND, {}, PORT, { reuseRunning: true })
    expect(await ensureRuntimeProcess(h.runtime, COMMAND, {}, PORT, { reuseRunning: true })).toEqual({ state: "ready" })
    expect([...h.state.launches.keys()]).toEqual(["/run/claxedo-runtime/launch-1"])
    expect(h.state.stops).toEqual([])
  })

  test("a running runtime is replaced, process group and all, when the caller says its env changed", async () => {
    const h = host()
    await ensureRuntimeProcess(h.runtime, COMMAND, { A: "1" }, PORT, { reuseRunning: true })
    expect(await ensureRuntimeProcess(h.runtime, COMMAND, { A: "2" }, PORT, { reuseRunning: false })).toEqual({ state: "ready" })
    expect(h.state.stops).toEqual(["/run/claxedo-runtime/launch-1"])
    expect([...h.state.launches.values()].map((launch) => launch.env.A)).toEqual(["2"])
  })

  test("a live runtime still preparing its repository keeps running across polls, so a large clone can finish", async () => {
    const h = host()
    h.state.healthy = () => false
    expect(await ensureRuntimeProcess(h.runtime, COMMAND, {}, PORT, { reuseRunning: true })).toEqual({ state: "preparing" })
    h.advance(20 * MINUTE)
    expect(await ensureRuntimeProcess(h.runtime, COMMAND, {}, PORT, { reuseRunning: true })).toEqual({ state: "preparing" })
    expect(h.state.stops).toEqual([])
  })

  test("a live runtime still not ready past the preparation limit is wedged and replaced", async () => {
    const h = host()
    h.state.healthy = () => false
    await ensureRuntimeProcess(h.runtime, COMMAND, {}, PORT, { reuseRunning: true })
    h.advance(36 * MINUTE)
    await ensureRuntimeProcess(h.runtime, COMMAND, {}, PORT, { reuseRunning: true })
    expect(h.state.stops).toEqual(["/run/claxedo-runtime/launch-1"])
    expect(h.recorded()?.id).toBe("launch-2")
  })

  test("a runtime that has answered ready is never replaced for a slow health check, however long it has run", async () => {
    const h = host()
    await ensureRuntimeProcess(h.runtime, COMMAND, {}, PORT, { reuseRunning: true })
    h.state.healthy = () => false
    h.advance(24 * 60 * MINUTE)
    expect(await ensureRuntimeProcess(h.runtime, COMMAND, {}, PORT, { reuseRunning: true })).toEqual({ state: "preparing" })
    expect(h.state.stops).toEqual([])
  })

  test("a runtime whose boot exits answers with the boot's own reason, credentials blanked, and is cleared so the next ensure boots afresh", async () => {
    const h = host()
    h.state.onLaunch = () => ({
      state: "exited",
      exitCode: 1,
      stderr: "cloning\nworkspace_runtime_boot_failed: Error: fatal: could not read from https://x:ghp_abcdefghijklmnopqrstuvwxyz@github.com/o/r\n    at boot (runtime.mjs:1)",
    })
    expect(await ensureRuntimeProcess(h.runtime, COMMAND, {}, PORT, { reuseRunning: true })).toEqual({
      state: "exited",
      reason: "fatal: could not read from https://[REDACTED]@github.com/o/r",
    })
    expect(h.state.launches.size).toBe(0)
    expect(h.recorded()).toBeUndefined()
  })

  test("a runtime that exited with no boot reason names its exit code", async () => {
    const h = host()
    h.state.onLaunch = () => ({ state: "exited", exitCode: 137 })
    expect(await ensureRuntimeProcess(h.runtime, COMMAND, {}, PORT, { reuseRunning: true })).toEqual({
      state: "exited",
      reason: "The workspace runtime process ended (exit code 137) before it was ready",
    })
  })

  test("a runtime that exited after serving is replaced even when the env is unchanged", async () => {
    const h = host()
    await ensureRuntimeProcess(h.runtime, COMMAND, {}, PORT, { reuseRunning: true })
    const [launch] = h.state.launches.values()
    launch.state = "exited"
    launch.exitCode = 0
    expect(await ensureRuntimeProcess(h.runtime, COMMAND, {}, PORT, { reuseRunning: true })).toEqual({ state: "ready" })
    expect(h.recorded()?.id).toBe("launch-2")
  })

  test("a launch the container no longer holds, as after a restart, is forgotten and launched again", async () => {
    const h = host()
    await ensureRuntimeProcess(h.runtime, COMMAND, {}, PORT, { reuseRunning: true })
    h.state.launches.clear()
    expect(await ensureRuntimeProcess(h.runtime, COMMAND, {}, PORT, { reuseRunning: true })).toEqual({ state: "ready" })
    expect(h.state.stops).toEqual([])
    expect(h.recorded()?.id).toBe("launch-2")
  })

  test("a touch reports serving only for a live launch that answers its health check", async () => {
    const h = host()
    expect(await runtimeServing(h.runtime, PORT)).toBe(false)
    await ensureRuntimeProcess(h.runtime, COMMAND, {}, PORT, { reuseRunning: true })
    expect(await runtimeServing(h.runtime, PORT)).toBe(true)
    h.state.healthy = () => false
    expect(await runtimeServing(h.runtime, PORT)).toBe(false)
  })
})
