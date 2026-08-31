import { afterEach, describe, expect, it, vi } from "vitest"
import {
  configureWorkspaceSupervisorPort,
  workspaceSupervisor,
  workspaceSupervisorInstalled,
} from "@claxedo/server-core/workspace/supervisor-port"

afterEach(() => {
  configureWorkspaceSupervisorPort(undefined)
})

describe("workspace supervisor port", () => {
  it("is a no-op before a composition installs one", async () => {
    // A composition without a supervisor has no cloud sandboxes, so "keep the
    // sandbox alive" is correctly nothing rather than a crash.
    expect(workspaceSupervisorInstalled()).toBe(false)
    expect(() => workspaceSupervisor().hold("ws_1")).not.toThrow()
    await expect(workspaceSupervisor().broadcastRuntimeConfig()).resolves.toBeUndefined()
  })

  it("routes every call to the installed supervisor", async () => {
    const calls: string[] = []
    configureWorkspaceSupervisorPort({
      hold: (id) => calls.push(`hold:${id}`),
      release: (id) => calls.push(`release:${id}`),
      markUse: (id) => calls.push(`markUse:${id}`),
      touch: (id) => calls.push(`touch:${id}`),
      broadcastRuntimeConfig: async () => { calls.push("broadcast") },
    })

    workspaceSupervisor().hold("ws_1")
    workspaceSupervisor().release("ws_1")
    workspaceSupervisor().markUse("ws_1")
    workspaceSupervisor().touch("ws_1")
    await workspaceSupervisor().broadcastRuntimeConfig()

    expect(calls).toEqual(["hold:ws_1", "release:ws_1", "markUse:ws_1", "touch:ws_1", "broadcast"])
  })

  it("is installed by the supervisor composition, so a cloud deployment never silently no-ops", async () => {
    // The failure this guards is quiet: without the install, a cloud sandbox
    // would stop being held open for a live stream and could be reaped
    // mid-response, with nothing in the logs to say why.
    vi.resetModules()
    const supervisor = await import("./supervisor")
    supervisor.configureWorkspaceSupervisor({ server_url: "http://127.0.0.1:3001" })

    const port = await import("@claxedo/server-core/workspace/supervisor-port")
    expect(port.workspaceSupervisorInstalled()).toBe(true)
  })
})

describe("workspace store lease reader", () => {
  it("is installed by the supervisor composition, or cloud workspaces vanish", async () => {
    // `visible()` in the workspace store hides a cloud workspace in
    // `acquiring_sandbox` until its lease reports ready, and the lease reader is
    // the ONLY thing that flips it — nothing else moves that status. Dropping
    // this install does not degrade gracefully: every successfully provisioned
    // cloud workspace, and its whole project, stays permanently invisible.
    vi.resetModules()
    const store = await import("@claxedo/server-core/workspace/store/index")
    expect(store.workspaceSandboxLeaseInstalled()).toBe(false)

    const supervisor = await import("./supervisor")
    supervisor.configureWorkspaceSupervisor({ server_url: "http://127.0.0.1:3001" })

    expect(store.workspaceSandboxLeaseInstalled()).toBe(true)
  })
})
