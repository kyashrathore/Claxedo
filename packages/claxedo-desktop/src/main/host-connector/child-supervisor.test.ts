import { describe, expect, test } from "bun:test"

import { runHostConnectorChild } from "../../../scripts/host-connector-entry"
import type {
  HostConnectorBootstrapIdentity,
  HostConnectorChildMessage,
  HostConnectorParentMessage,
  HostConnectorSharedWorkspace,
} from "./child-protocol"
import {
  HOST_CONNECTOR_AUTH_LAPSE_DETAIL,
  setupHostConnectorChild,
  type HostConnectorChildProcess,
} from "./child-supervisor"

async function until(condition: () => boolean, description: string) {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    if (condition()) return
    await Bun.sleep(0)
  }
  throw new Error(`timed out waiting for ${description}`)
}

class FakeChild implements HostConnectorChildProcess {
  #messages: Array<(message: unknown) => void> = []
  #exit: ((code: number) => void) | undefined
  #receive: ((message: HostConnectorParentMessage) => void) | undefined
  #runtime: ReturnType<typeof runHostConnectorChild> | undefined
  killed = false
  parentMessages: HostConnectorParentMessage[] = []

  constructor(autoStart = true) {
    if (!autoStart) return
    queueMicrotask(() => {
      if (this.killed) return
      this.#runtime = runHostConnectorChild({
        onMessage: (listener) => {
          this.#receive = listener as (message: HostConnectorParentMessage) => void
        },
        postMessage: (message) => this.emit(message),
      })
    })
  }

  postMessage(message: HostConnectorParentMessage) {
    this.parentMessages.push(message)
    this.#receive?.(message)
  }

  kill() {
    if (this.killed) return false
    this.killed = true
    this.#runtime?.close()
    this.#exit?.(0)
    return true
  }

  on(event: "message", listener: (message: unknown) => void) {
    if (event === "message") this.#messages.push(listener)
  }

  once(event: "exit", listener: (code: number) => void) {
    if (event === "exit") this.#exit = listener
  }

  emit(message: HostConnectorChildMessage | unknown) {
    for (const listener of this.#messages) listener(message)
  }

  crash(code: number) {
    if (this.killed) return
    this.killed = true
    this.#runtime?.close()
    this.#exit?.(code)
  }
}

function harness(options?: {
  /** Shares this machine already published, as a previous run left them. */
  sharedWorkspaces?: readonly HostConnectorSharedWorkspace[]
  /** What this machine says about a workspace it shares. */
  describeWorkspace?: Parameters<typeof setupHostConnectorChild>[0]["describeWorkspace"]
  /** Fail every spawn from this attempt onwards (1 = the first). */
  spawnFailsFrom?: number
}) {
  const children: FakeChild[] = []
  const operations: Array<{ name: string; input?: Record<string, unknown> }> = []
  const errors: Array<{ stage: string; error: unknown }> = []
  const statuses: unknown[] = []
  let identity: HostConnectorBootstrapIdentity | undefined
  let clears = 0
  let loads = 0
  let stores = 0
  let spawns = 0
  let shareLoads = 0
  const shareStores: Array<readonly HostConnectorSharedWorkspace[]> = []
  const connector = setupHostConnectorChild({
    ...(options?.describeWorkspace ? { describeWorkspace: options.describeWorkspace } : {}),
    loadSharedWorkspaces: () => {
      shareLoads++
      return options?.sharedWorkspaces ?? []
    },
    storeSharedWorkspaces: (next) => {
      shareStores.push(next)
    },
    spawn: () => {
      spawns++
      if (options?.spawnFailsFrom !== undefined && spawns >= options.spawnFailsFrom) {
        throw new Error("the connector executable is missing")
      }
      const child = new FakeChild()
      children.push(child)
      return child
    },
    loadIdentity: async () => {
      loads++
      return { ok: true as const, ...(identity ? { identity } : {}) }
    },
    storeIdentity: async (created) => {
      stores++
      identity = structuredClone(created)
      return { ok: true as const }
    },
    clearIdentity: () => {
      clears++
      identity = undefined
    },
    runAccountOperation: async (name, input) => {
      operations.push({ name, ...(input ? { input } : {}) })
      const hostId = String(input?.hostId)
      if (name === "host.enrollmentNonce") return { request_id: "req_1", nonce: "nonce_1", expires_at: 9_999 }
      if (name === "host.enrollCurrentMachine") {
        return { enrollment: { enrollment_id: "enr_1", host_id: hostId, expires_at: 10_000 } }
      }
      if (name === "host.enrollmentHeartbeat") return { expires_at: 11_000 }
      if (name === "workspace.assignHost") return { assigned: true, workspace_id: String(input?.id), host_id: hostId }
      throw new Error(`unexpected account operation ${name}`)
    },
    onError: (stage, error) => errors.push({ stage, error }),
    onStatusChange: (status) => statuses.push(status),
    displayName: "Work laptop",
  })
  return {
    connector,
    children,
    operations,
    errors,
    statuses,
    identity: () => identity,
    counts: () => ({ loads, stores, clears }),
    shareCounts: () => ({ loads: shareLoads, stores: shareStores.length }),
    shareStores,
    bootstrapOf: (index: number) =>
      children[index]?.parentMessages.find((message) => message.type === "bootstrap") as
        | Extract<HostConnectorParentMessage, { type: "bootstrap" }>
        | undefined,
  }
}

describe("Electron-main child lifecycle", () => {
  test("construction performs no identity read and spawns no optional child", () => {
    const host = harness()

    expect(host.connector.status()).toEqual({ status: "not-started" })
    expect(host.children).toEqual([])
    expect(host.counts()).toEqual({ loads: 0, stores: 0, clears: 0 })
  })

  test("start spawns one child, persists its key before enrollment, and brokers only named operations", async () => {
    const host = harness()

    const status = await host.connector.start()

    expect(status).toMatchObject({ status: "enrolled", enrollment: { enrollment_id: "enr_1" } })
    expect(host.children).toHaveLength(1)
    expect(host.counts()).toEqual({ loads: 1, stores: 1, clears: 0 })
    expect(host.identity()?.privateKeyJwk).toHaveProperty("d")
    expect(host.operations.map((operation) => operation.name)).toEqual([
      "host.enrollmentNonce",
      "host.enrollCurrentMachine",
    ])
    expect(JSON.stringify(host.operations)).not.toMatch(/authorization|bearer|access_?token/i)
  })

  test("a share records the machine's own description of the workspace on the assignment", async () => {
    const host = harness({
      describeWorkspace: async (workspaceId) =>
        workspaceId === "ws_1"
          ? { displayName: "Claxedo", directory: "/Users/me/test/opencode", repoName: "Claxedo", gitBranch: "dev" }
          : undefined,
    })
    await host.connector.start()
    // Owner intent is declared first; whether the machine's consent beat then
    // settles is the child's business and not what this test reads.
    await host.connector.shareWorkspace({ workspaceId: "ws_1" }).catch(() => undefined)
    expect(host.operations.find((operation) => operation.name === "workspace.assignHost")?.input).toEqual({
      id: "ws_1",
      hostId: expect.any(String),
      displayName: "Claxedo",
      remoteDirectory: "/Users/me/test/opencode",
      repoName: "Claxedo",
      gitBranch: "dev",
    })
  })

  test("concurrent and repeated starts own exactly one live child", async () => {
    const host = harness()

    const [first, second] = await Promise.all([host.connector.start(), host.connector.start()])
    const third = await host.connector.start()

    expect(first).toMatchObject({ status: "enrolled" })
    expect(second).toEqual(first)
    expect(third).toEqual(first)
    expect(host.children).toHaveLength(1)
    expect(host.operations.filter((operation) => operation.name === "host.enrollCurrentMachine")).toHaveLength(1)
  })

  test("retires a live child that reported stopped before launching its replacement", async () => {
    const host = harness()
    await host.connector.start()
    host.children[0]!.emit({ type: "status", status: { status: "stopped", reason: "closed", detail: "remote stopped" } })
    await until(() => host.connector.status().status === "stopped", "stopped child state")

    await host.connector.start()

    expect(host.children).toHaveLength(2)
    expect(host.children[0]!.killed).toBe(true)
    expect(host.children.filter((child) => !child.killed)).toHaveLength(1)
  })

  test("pause terminates the owned process and resume restores the same identity in one new child", async () => {
    const host = harness()
    await host.connector.start()
    const hostId = host.identity()!.hostId

    host.connector.stop()
    expect(host.children[0]?.killed).toBe(true)
    expect(host.connector.status()).toMatchObject({ status: "stopped", reason: "closed" })

    await host.connector.start()

    expect(host.children).toHaveLength(2)
    expect(host.counts()).toEqual({ loads: 2, stores: 1, clears: 0 })
    const secondBootstrap = host.children[1]!.parentMessages.find((message) => message.type === "bootstrap")
    expect(secondBootstrap).toMatchObject({ identity: { hostId } })
  })

  test("revoke deletes the persistent identity and terminates the child", async () => {
    const host = harness()
    await host.connector.start()

    host.connector.revoke()

    expect(host.children[0]?.killed).toBe(true)
    expect(host.identity()).toBeUndefined()
    expect(host.counts().clears).toBe(1)
    expect(host.connector.status()).toMatchObject({ status: "stopped", reason: "revoked" })
  })

  test("a failed identity deletion still terminates the child and does not claim revocation", async () => {
    const children: FakeChild[] = []
    const connector = setupHostConnectorChild({
      spawn: () => {
        const child = new FakeChild()
        children.push(child)
        return child
      },
      loadIdentity: async () => ({ ok: true }),
      storeIdentity: async () => ({ ok: true }),
      clearIdentity: () => {
        throw new Error("keychain record is locked")
      },
      runAccountOperation: async (name, input) => {
        const hostId = String(input?.hostId)
        if (name === "host.enrollmentNonce") return { request_id: "r", nonce: "n", expires_at: 1 }
        return { enrollment: { enrollment_id: "e", host_id: hostId, expires_at: 1 } }
      },
    })
    await connector.start()

    connector.revoke()

    expect(children[0]?.killed).toBe(true)
    expect(connector.status()).toMatchObject({ status: "stopped", reason: "error" })
  })

  test("an unexpected exit becomes an explicit error without affecting the account runner", async () => {
    const host = harness()
    await host.connector.start()

    host.children[0]!.crash(9)
    await until(() => host.connector.status().status === "stopped", "child exit state")

    expect(host.connector.status()).toMatchObject({ status: "stopped", reason: "error" })
    expect(host.errors.map((entry) => entry.stage)).toContain("child-exit")
    expect(host.statuses).toContainEqual(expect.objectContaining({ status: "stopped", reason: "error" }))
  })

  test("an exit before ready rejects startup instead of leaving it pending", async () => {
    const children: FakeChild[] = []
    const connector = setupHostConnectorChild({
      spawn: () => {
        const child = new FakeChild(false)
        children.push(child)
        return child
      },
      loadIdentity: async () => ({ ok: true }),
      storeIdentity: async () => ({ ok: true }),
      clearIdentity: () => {},
      runAccountOperation: async () => {
        throw new Error("must not run")
      },
    })

    const starting = connector.start()
    await until(() => children.length === 1, "child spawn")
    children[0]!.crash(17)

    await expect(starting).resolves.toMatchObject({ status: "stopped", reason: "error" })
  })

  test("pause during pre-ready startup resolves immediately as closed", async () => {
    const children: FakeChild[] = []
    const connector = setupHostConnectorChild({
      spawn: () => {
        const child = new FakeChild(false)
        children.push(child)
        return child
      },
      loadIdentity: async () => ({ ok: true }),
      storeIdentity: async () => ({ ok: true }),
      clearIdentity: () => {},
      runAccountOperation: async () => {
        throw new Error("must not run")
      },
      startupTimeoutMs: 60_000,
    })

    const starting = connector.start()
    await until(() => children.length === 1, "child spawn")
    connector.stop()

    await expect(starting).resolves.toMatchObject({ status: "stopped", reason: "closed" })
    expect(children[0]!.killed).toBe(true)
    expect(connector.status()).toMatchObject({ status: "stopped", reason: "closed" })
  })

  test("pause cancels a startup waiting on identity restore", async () => {
    let release!: () => void
    const loading = new Promise<void>((resolve) => {
      release = resolve
    })
    const connector = setupHostConnectorChild({
      spawn: () => new FakeChild(),
      loadIdentity: async () => {
        await loading
        return { ok: true }
      },
      storeIdentity: async () => ({ ok: true }),
      clearIdentity: () => {},
      runAccountOperation: async () => undefined,
    })

    const starting = connector.start()
    await Promise.resolve()
    connector.stop()

    await expect(starting).resolves.toMatchObject({ status: "stopped", reason: "closed" })
    release()
  })

  test("a control-plane stall longer than the bootstrap budget still enrols", async () => {
    const children: FakeChild[] = []
    const statuses: unknown[] = []
    const connector = setupHostConnectorChild({
      spawn: () => {
        const child = new FakeChild()
        children.push(child)
        return child
      },
      loadIdentity: async () => ({ ok: true }),
      storeIdentity: async () => ({ ok: true }),
      clearIdentity: () => {},
      runAccountOperation: async (name, input) => {
        const hostId = String(input?.hostId)
        if (name === "host.enrollmentNonce") {
          // The live defect, scaled to a test clock: the edge withheld this
          // POST for ~12s against a 10s bootstrap budget. Three times the
          // budget here is the same relationship without the wall time.
          await Bun.sleep(750)
          return { request_id: "req_1", nonce: "nonce_1", expires_at: 9_999 }
        }
        if (name === "host.enrollCurrentMachine") {
          return { enrollment: { enrollment_id: "enr_1", host_id: hostId, expires_at: 10_000 } }
        }
        return { expires_at: 11_000 }
      },
      onStatusChange: (status) => statuses.push(status),
      startupTimeoutMs: 250,
      enrollmentTimeoutMs: 10_000,
    })

    await expect(connector.start()).resolves.toMatchObject({
      status: "enrolled",
      enrollment: { enrollment_id: "enr_1" },
    })
    expect(children[0]!.killed).toBe(false)
    // The bootstrap reply was published while the stall was still open, so a
    // panel open during a slow enrollment sees a starting machine.
    expect(statuses).toEqual([{ status: "idle" }, expect.objectContaining({ status: "enrolled" })])
  })

  test("an enrollment the control plane refuses resolves with the connector's own detail", async () => {
    const children: FakeChild[] = []
    const connector = setupHostConnectorChild({
      spawn: () => {
        const child = new FakeChild()
        children.push(child)
        return child
      },
      loadIdentity: async () => ({ ok: true }),
      storeIdentity: async () => ({ ok: true }),
      clearIdentity: () => {},
      runAccountOperation: async () => {
        throw new Error("host enrollment is not permitted for this account")
      },
      startupTimeoutMs: 1_000,
      enrollmentTimeoutMs: 10_000,
    })

    const settled = await connector.start()

    // `electronMachineRemoteAccess.enable()` throws this detail verbatim, so a
    // refusal has to survive the trip rather than be replaced by a generic
    // supervisor error.
    expect(settled).toMatchObject({ status: "stopped", reason: "error" })
    expect((settled as { detail: string }).detail).toContain("host enrollment is not permitted for this account")
  })

  test("an enrollment that never answers is bounded by the enrollment budget, not the bootstrap one", async () => {
    const children: FakeChild[] = []
    const connector = setupHostConnectorChild({
      spawn: () => {
        const child = new FakeChild()
        children.push(child)
        return child
      },
      loadIdentity: async () => ({ ok: true }),
      storeIdentity: async () => ({ ok: true }),
      clearIdentity: () => {},
      runAccountOperation: () => new Promise(() => {}),
      startupTimeoutMs: 1_000,
      enrollmentTimeoutMs: 40,
    })

    const settled = await connector.start()

    expect(settled).toMatchObject({ status: "stopped", reason: "error" })
    expect((settled as { detail: string }).detail).toContain("Host Connector child enrollment timed out after 40ms")
    expect(children[0]!.killed).toBe(true)
  })

  test("a child that neither becomes ready nor exits is terminated by the startup bound", async () => {
    const children: FakeChild[] = []
    const connector = setupHostConnectorChild({
      spawn: () => {
        const child = new FakeChild(false)
        children.push(child)
        return child
      },
      loadIdentity: async () => ({ ok: true }),
      storeIdentity: async () => ({ ok: true }),
      clearIdentity: () => {},
      runAccountOperation: async () => {
        throw new Error("must not run")
      },
      startupTimeoutMs: 1,
    })

    await expect(connector.start()).resolves.toMatchObject({ status: "stopped", reason: "error" })
    expect(children[0]?.killed).toBe(true)
  })
})

/**
 * The live defect these cover.
 *
 * A ~2s control-plane redeploy answered the auth descriptor with 503. The
 * account left "signed", main stopped the connector (correctly — never beat
 * with a credential the deployment may have revoked), the 60s enrollment lease
 * expired, and every client was told this machine was offline. Nothing ever
 * resumed, because a transient lapse and "the user turned remote access off"
 * were the same event to this supervisor.
 *
 * Both halves are load-bearing and both are asserted here: the stop still
 * happens, AND a stop nobody chose is undone exactly once when the account
 * returns.
 */
describe("auth-lapse suspension", () => {
  const shares = [{ workspaceId: "ws_1", displayName: "Repo" }] as const

  test("fails closed on auth loss, then restores the machine and its served workspaces", async () => {
    const host = harness({ sharedWorkspaces: shares })
    await host.connector.start()
    expect(host.bootstrapOf(0)?.sharedWorkspaces).toEqual(shares)

    // Fail closed. Unchanged by this work, and asserted so it stays that way:
    // the child is gone and the machine is off the air the moment auth lapses.
    expect(host.connector.suspendForAuthLapse()).toBe(true)
    expect(host.children[0]!.killed).toBe(true)
    expect(host.connector.status()).toEqual({
      status: "stopped",
      reason: "closed",
      detail: HOST_CONNECTOR_AUTH_LAPSE_DETAIL,
    })

    const resumed = await host.connector.resumeAfterAuthLapse()

    expect(resumed).toMatchObject({ status: "enrolled" })
    expect(host.children).toHaveLength(2)
    // The point of the fix: the machine comes back publishing what it was
    // publishing, from the list the supervisor already keeps. One load, at
    // construction — a second store would mean a second source of truth.
    expect(host.bootstrapOf(1)?.sharedWorkspaces).toEqual(shares)
    expect(host.shareCounts()).toEqual({ loads: 1, stores: 0 })
  })

  test("a user pause is never undone by a later sign-in", async () => {
    const host = harness({ sharedWorkspaces: shares })
    await host.connector.start()
    host.connector.suspendForAuthLapse()

    // The user reaches the panel while the account is down and turns remote
    // access off. That is a decision, and it outranks the pending restore.
    host.connector.stop()

    expect(await host.connector.resumeAfterAuthLapse()).toBeUndefined()
    expect(host.children).toHaveLength(1)
    expect(host.connector.status()).toMatchObject({ status: "stopped", detail: "connector closed" })
  })

  test("a user revoke is never undone by a later sign-in", async () => {
    const host = harness({ sharedWorkspaces: shares })
    await host.connector.start()
    host.connector.suspendForAuthLapse()

    host.connector.revoke()

    expect(await host.connector.resumeAfterAuthLapse()).toBeUndefined()
    expect(host.children).toHaveLength(1)
    expect(host.identity()).toBeUndefined()
  })

  test("a pause with no lapse behind it leaves nothing for a sign-in to resume", async () => {
    const host = harness()
    await host.connector.start()

    host.connector.stop()

    expect(await host.connector.resumeAfterAuthLapse()).toBeUndefined()
    expect(host.children).toHaveLength(1)
  })

  test("a failed restart is not retried until another suspension", async () => {
    const host = harness({ spawnFailsFrom: 2 })
    await host.connector.start()
    expect(host.connector.suspendForAuthLapse()).toBe(true)

    const failed = await host.connector.resumeAfterAuthLapse()

    expect(failed).toMatchObject({ status: "stopped", reason: "error" })
    expect(host.children).toHaveLength(1)
    // One attempt was the whole budget. Every later account transition — and
    // this daemon sees many — must find nothing to do, or a machine whose
    // executable is missing would re-spawn forever behind a silent log.
    expect(await host.connector.resumeAfterAuthLapse()).toBeUndefined()
    expect(host.connector.suspendForAuthLapse()).toBe(false)
    expect(await host.connector.resumeAfterAuthLapse()).toBeUndefined()
    expect(host.children).toHaveLength(1)
  })

  test("an account merely becoming signed never publishes a machine that was not running", async () => {
    const host = harness()

    // The launch path. `restore()` publishes `signed` on most signed launches,
    // and that must not enrol anything — same invariant `index.ts` holds by
    // never calling `start()`.
    expect(host.connector.suspendForAuthLapse()).toBe(false)
    expect(await host.connector.resumeAfterAuthLapse()).toBeUndefined()

    expect(host.children).toHaveLength(0)
    expect(host.counts()).toEqual({ loads: 0, stores: 0, clears: 0 })
    expect(host.connector.status()).toEqual({ status: "not-started" })
  })

  test("pressing Enable during a suspension takes ownership of the machine's state", async () => {
    const host = harness({ sharedWorkspaces: shares })
    await host.connector.start()
    host.connector.suspendForAuthLapse()

    // The user did not wait for the account; they enabled it themselves.
    await host.connector.start()

    expect(host.children).toHaveLength(2)
    expect(await host.connector.resumeAfterAuthLapse()).toBeUndefined()
    expect(host.children).toHaveLength(2)
  })
})

describe("main-side protocol guard", () => {
  test("drops an undeclared account operation from a compromised child", async () => {
    const host = harness()
    await host.connector.start()
    const before = host.operations.length

    host.children[0]!.emit({
      type: "account-operation",
      requestId: "hostile",
      name: "billing.updateSubscription",
      input: { url: "https://attacker.invalid" },
    })
    await Bun.sleep(0)

    expect(host.operations).toHaveLength(before)
    expect(host.children[0]!.parentMessages.some((message) => message.type === "account-result" && message.requestId === "hostile")).toBe(false)
  })

  test("drops a late account result after revocation without an unhandled transport error", async () => {
    let release!: (value: unknown) => void
    const operation = new Promise<unknown>((resolve) => {
      release = resolve
    })
    const children: FakeChild[] = []
    const errors: Array<{ stage: string; error: unknown }> = []
    const connector = setupHostConnectorChild({
      spawn: () => {
        const child = new FakeChild(false)
        children.push(child)
        return child
      },
      loadIdentity: async () => ({ ok: true }),
      storeIdentity: async () => ({ ok: true }),
      clearIdentity: () => {},
      runAccountOperation: async () => await operation,
      onError: (stage, error) => errors.push({ stage, error }),
    })
    const starting = connector.start()
    await until(() => children.length === 1, "child spawn")
    children[0]!.emit({ type: "ready" })
    await until(() => children[0]!.parentMessages.some((message) => message.type === "bootstrap"), "bootstrap")
    children[0]!.emit({ type: "account-operation", requestId: "late", name: "host.enrollmentNonce", input: { hostId: "h" } })

    connector.revoke()
    release({ request_id: "r", nonce: "n" })
    await starting
    await Bun.sleep(0)

    expect(errors.find((entry) => entry.stage === "child-message")).toBeUndefined()
    expect(children[0]!.parentMessages.some((message) => message.type === "account-result" && message.requestId === "late")).toBe(false)
  })
})
