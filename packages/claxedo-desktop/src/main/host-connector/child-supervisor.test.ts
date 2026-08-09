import { describe, expect, test } from "bun:test"

import { runHostConnectorChild } from "../../../scripts/host-connector-entry"
import type {
  HostConnectorBootstrapIdentity,
  HostConnectorChildMessage,
  HostConnectorParentMessage,
} from "./child-protocol"
import { setupHostConnectorChild, type HostConnectorChildProcess } from "./child-supervisor"

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

function harness() {
  const children: FakeChild[] = []
  const operations: Array<{ name: string; input?: Record<string, unknown> }> = []
  const errors: Array<{ stage: string; error: unknown }> = []
  const statuses: unknown[] = []
  let identity: HostConnectorBootstrapIdentity | undefined
  let clears = 0
  let loads = 0
  let stores = 0
  const connector = setupHostConnectorChild({
    spawn: () => {
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
})
