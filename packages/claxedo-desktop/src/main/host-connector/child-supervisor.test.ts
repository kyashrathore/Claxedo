import { describe, expect, test } from "bun:test"

import { createFakeControlPlane } from "@claxedo/host-connector/test-support"
import { HOST_ENROLLMENT_HEARTBEAT_PATH, type FetchLike } from "@claxedo/host-connector/machine-transport"

import { runHostConnectorChild } from "../../../scripts/host-connector-entry"
import type {
  HostConnectorBootstrapIdentity,
  HostConnectorParentMessage,
  HostConnectorProviderConfig,
  HostConnectorProviderConfigReady,
  HostConnectorServing,
  HostConnectorSharedWorkspace,
} from "./child-protocol"
import {
  HOST_CONNECTOR_AUTH_LAPSE_DETAIL,
  setupHostConnectorChild,
  type HostConnectorChildProcess,
} from "./child-supervisor"

/**
 * Poll against the clock, not a turn count: every wait here spans real signing
 * and real requests to the fake control plane, so how many microtask turns one
 * takes depends on how busy the machine running the suite is.
 */
async function until(condition: () => boolean, description: string, budgetMs = 5_000) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (condition()) return
    await Bun.sleep(0)
  }
  throw new Error(`timed out waiting for ${description}`)
}

const CONTROL_PLANE_URL = "https://control-plane.test"

/**
 * The real child, in the process the supervisor thinks it spawned, with the
 * fake control plane behind its own `fetch`: everything after the two account
 * operations is a machine-signed request that fake verifies.
 */
class FakeChild implements HostConnectorChildProcess {
  #messages: Array<(message: unknown) => void> = []
  #exit: ((code: number) => void) | undefined
  #receive: ((message: HostConnectorParentMessage) => void) | undefined
  #runtime: ReturnType<typeof runHostConnectorChild> | undefined
  killed = false
  parentMessages: HostConnectorParentMessage[] = []

  constructor(options: { autoStart?: boolean; fetch?: FetchLike } = {}) {
    if (options.autoStart === false) return
    queueMicrotask(() => {
      if (this.killed) return
      this.#runtime = runHostConnectorChild(
        {
          onMessage: (listener) => {
            this.#receive = listener as (message: HostConnectorParentMessage) => void
          },
          postMessage: (message) => this.emit(message),
        },
        { fetch: options.fetch ?? (async () => new Response("no control plane in this test", { status: 503 })) },
      )
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

  emit(message: unknown) {
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
  /** What the daemon answers when asked how its runtimes were composed. */
  sessionAuthority?: () => Promise<"local" | "managed-private" | undefined>
  /** Hold every machine beat open this long, as a slow deployment would. */
  beatDelayMs?: number
  startupTimeoutMs?: number
  heartbeatIntervalMs?: number
  /** What main's store answers for a delivered revision; stored unless the test says otherwise. */
  storeProviderConfig?: () => boolean
}) {
  const cp = createFakeControlPlane()
  const beatDelayMs = options?.beatDelayMs
  const childFetch: FetchLike =
    beatDelayMs === undefined
      ? cp.fetch
      : async (input, init) => {
        const answered = await cp.fetch(input, init)
        // After the fake has verified the request: its nonce and skew checks
        // read the clock on arrival, so a delay in front of them would be
        // testing replay protection instead of the supervisor's bound.
        if (input.pathname === HOST_ENROLLMENT_HEARTBEAT_PATH) await Bun.sleep(beatDelayMs)
        return answered
      }
  const children: FakeChild[] = []
  const operations: Array<{ name: string; input?: Record<string, unknown> }> = []
  const errors: Array<{ stage: string; error: unknown }> = []
  const statuses: unknown[] = []
  const servings: HostConnectorServing[] = []
  const providerConfigs: HostConnectorProviderConfig[] = []
  const providerReady: HostConnectorProviderConfigReady[] = []
  let identity: HostConnectorBootstrapIdentity | undefined
  let providerConfig: HostConnectorProviderConfig | undefined
  let clears = 0
  let loads = 0
  let stores = 0
  let spawns = 0
  let shareLoads = 0
  let storedName: string | undefined
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
      const child = new FakeChild({ fetch: childFetch })
      children.push(child)
      return child
    },
    controlPlaneUrl: CONTROL_PLANE_URL,
    ...(options?.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: options.startupTimeoutMs }),
    ...(options?.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
    loadIdentity: async () => {
      loads++
      return { ok: true as const, ...(identity ? { identity } : {}), ...(providerConfig ? { providerConfig } : {}) }
    },
    storeIdentity: async (created) => {
      stores++
      identity = structuredClone(created)
      providerConfig = undefined
      return { ok: true as const }
    },
    storeSealingKey: async (sealingPrivateKeyJwk) => {
      if (!identity) return { ok: false as const, detail: "no identity" }
      identity = { ...identity, sealingPrivateKeyJwk }
      return { ok: true as const }
    },
    storeProviderConfig: async (config) => {
      providerConfigs.push(config)
      if (!(options?.storeProviderConfig?.() ?? true)) return { ok: false as const, detail: "safeStorage refused the write" }
      providerConfig = config
      return { ok: true as const }
    },
    clearIdentity: () => {
      clears++
      identity = undefined
      providerConfig = undefined
    },
    runAccountOperation: async (name, input) => {
      operations.push({ name, ...(input ? { input } : {}) })
      const hostId = String(input?.hostId)
      if (name === "host.enrollmentNonce") return { request_id: "req_1", nonce: "nonce_1", expires_at: 9_999 }
      if (name === "host.enrollCurrentMachine") {
        return { enrollment: await cp.enrollAccountHost({ hostId, publicKey: String(input?.publicKey) }) }
      }
      if (name === "workspace.assignHost") {
        // A share with no description reaches the control plane without a
        // directory, exactly as the route records it, and a row like that
        // describes nothing the machine can be handed back.
        cp.assign({
          hostId,
          workspaceId: String(input?.id),
          ...(typeof input?.remoteDirectory === "string" ? { remoteDirectory: input.remoteDirectory } : {}),
          ...(typeof input?.displayName === "string" ? { displayName: input.displayName } : {}),
        })
        return { assigned: true, workspace_id: String(input?.id), host_id: hostId }
      }
      if (name === "host.renameCurrentMachine") {
        return { enrollment_id: String(input?.enrollmentId), display_name: String(input?.displayName) }
      }
      if (name === "workspace.unassignHost") {
        cp.unassign(String(input?.id))
        return { unassigned: true }
      }
      throw new Error(`unexpected account operation ${name}`)
    },
    onError: (stage, error) => errors.push({ stage, error }),
    onStatusChange: (status) => statuses.push(status),
    onServing: (serving) => servings.push(serving),
    onProviderConfig: (config) => providerReady.push(config),
    displayName: () => storedName ?? "Work laptop",
    storeDisplayName: (name: string) => { storedName = name },
    ...(options?.sessionAuthority ? { sessionAuthority: options.sessionAuthority } : {}),
  })
  return {
    cp,
    connector,
    children,
    operations,
    errors,
    statuses,
    servings,
    providerConfigs,
    providerReady,
    identity: () => identity,
    providerConfig: () => providerConfig,
    counts: () => ({ loads, stores, clears }),
    shareCounts: () => ({ loads: shareLoads, stores: shareStores.length }),
    storedName: () => storedName,
    shareStores,
    bootstrapOf: (index: number) =>
      children[index]?.parentMessages.find((message) => message.type === "bootstrap"),
  }
}

describe("declared session composition", () => {
  test("hands the daemon's composition to the child before its first beat", async () => {
    // The connector signs and sends every heartbeat but did not compose the
    // runtimes it beats for — the daemon did. Resolving it BEFORE the
    // bootstrap matters: the first beat already carries the declaration, and
    // the control plane mints every client's event-stream scope from it, so a
    // value that arrived afterwards would leave the first connections with no
    // workspace stream. Both flavours, because a bootstrap that hard-coded one
    // would still satisfy a single-value test.
    for (const declared of ["local", "managed-private"] as const) {
      const host = harness({ sessionAuthority: async () => declared })
      await host.connector.start()
      expect(host.bootstrapOf(0)?.sessionAuthority).toBe(declared)
    }
  })

  test("publishes an undeclared machine when the daemon cannot answer, and says why", async () => {
    // A daemon that is unreachable must not stall the launch and must not be
    // guessed for. The machine enrolls undeclared — the control plane records
    // the absence and mints no scope — and the failure is reported rather than
    // swallowed.
    const host = harness({
      sessionAuthority: async () => {
        throw new Error("HOSTED_HTTP 503 daemon not ready")
      },
    })

    await expect(host.connector.start()).resolves.toMatchObject({ status: "enrolled" })
    expect(host.bootstrapOf(0)).not.toHaveProperty("sessionAuthority")
    expect(host.errors.map((entry) => entry.stage)).toContain("session-authority")
  })
})

const RELAY_JWKS_URL = "https://relay.test/.well-known/jwks.json"
const SESSION_AUTHORITY_URL = "https://control-plane.test/api/runtime-authority/session-authorize"

describe("what an ack tells the daemon", () => {
  test("the addresses reach the serving push beside the credential", async () => {
    // Both, in one hand-off: the daemon verifies a relayed caller's Relay Host
    // Token against the key set and asks the authority whether that caller may
    // read the session, so a credential delivered without them opens a tunnel
    // that answers 503 to every relayed read.
    const host = harness({
      describeWorkspace: async () => ({ displayName: "Claxedo", directory: "/Users/me/test/opencode" }),
    })
    await host.connector.start()

    await until(() => host.servings.length > 0, "the first serving push")
    expect(host.servings.at(-1)).toEqual({
      tunnel: null,
      endpoints: { relayJwksUrl: RELAY_JWKS_URL, sessionAuthorityUrl: SESSION_AUTHORITY_URL },
    })

    await host.connector.shareWorkspace({ workspaceId: "ws_1" })
    await until(() => host.servings.some((serving) => serving.tunnel !== null), "the credential push")

    const serving = host.servings.at(-1)
    expect(serving?.tunnel).toMatchObject({ workspaceIds: ["ws_1"] })
    // The control plane names them once and the daemon needs them on every
    // push, so the credential-bearing ack restates the addresses the first one
    // delivered rather than arriving without them.
    expect(serving?.endpoints).toEqual({
      relayJwksUrl: RELAY_JWKS_URL,
      sessionAuthorityUrl: SESSION_AUTHORITY_URL,
    })
  })

  // The daemon declares the machine to its own clients out of this credential,
  // and a client compares that declaration against the host a control-plane
  // workspace row names. Read off the enrollment the child actually beat
  // under, so the two cannot agree by being written twice.
  test("the credential names the enrollment this machine beat under", async () => {
    const host = harness({
      describeWorkspace: async () => ({ displayName: "Claxedo", directory: "/Users/me/test/opencode" }),
    })
    const started = await host.connector.start()
    const enrollmentId = started.status === "enrolled" ? started.enrollment.enrollment_id : undefined
    expect(enrollmentId).toBeTruthy()

    await host.connector.shareWorkspace({ workspaceId: "ws_1" })
    await until(() => host.servings.some((serving) => serving.tunnel !== null), "the credential push")

    expect(host.servings.at(-1)?.tunnel).toMatchObject({ enrollmentId })
  })

  test("every stop withdraws the credential instead of leaving it to the lease", async () => {
    for (const stop of ["pause", "revoke", "quit"] as const) {
      const host = harness({
        describeWorkspace: async () => ({ displayName: "Claxedo", directory: "/Users/me/test/opencode" }),
      })
      await host.connector.start()
      await host.connector.shareWorkspace({ workspaceId: "ws_1" })
      await until(() => host.servings.some((serving) => serving.tunnel !== null), `the credential push (${stop})`)

      if (stop === "pause") host.connector.stop()
      if (stop === "revoke") host.connector.revoke()
      if (stop === "quit") host.connector.dispose()

      expect(host.servings.at(-1)).toEqual({ tunnel: null })
    }
  })

  test("a lapse suspension withdraws the credential, and the resumed machine restores it", async () => {
    const host = harness({
      describeWorkspace: async () => ({ displayName: "Claxedo", directory: "/Users/me/test/opencode" }),
    })
    await host.connector.start()
    await host.connector.shareWorkspace({ workspaceId: "ws_1" })
    await until(() => host.servings.some((serving) => serving.tunnel !== null), "the credential push")

    expect(host.connector.suspendForAuthLapse()).toBe(true)
    expect(host.servings.at(-1)).toEqual({ tunnel: null })

    await host.connector.resumeAfterAuthLapse()
    await until(
      () => host.servings.at(-1)?.tunnel !== null && host.servings.at(-1)?.tunnel !== undefined,
      "the credential push after the resume",
    )
    expect(host.servings.at(-1)?.tunnel).toMatchObject({ workspaceIds: ["ws_1"] })
  })
})

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

    expect(status).toMatchObject({
      status: "enrolled",
      enrollment: { enrollment_id: [...host.cp.enrollments.keys()][0] },
    })
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
    await host.connector.shareWorkspace({ workspaceId: "ws_1" })
    expect(host.operations.find((operation) => operation.name === "workspace.assignHost")?.input).toEqual({
      id: "ws_1",
      hostId: expect.any(String),
      displayName: "Claxedo",
      remoteDirectory: "/Users/me/test/opencode",
      repoName: "Claxedo",
      gitBranch: "dev",
    })
  })

  test("the share is complete only when the machine has acked the owner's description", async () => {
    const host = harness({
      describeWorkspace: async () => ({ displayName: "Claxedo", directory: "/Users/me/test/opencode" }),
    })
    await host.connector.start()
    const enrollmentId = [...host.cp.enrollments.keys()][0]

    const settled = await host.connector.shareWorkspace({ workspaceId: "ws_1" })

    expect(settled).toMatchObject({ status: "enrolled", sharedWorkspaceIds: ["ws_1"] })
    await until(() => host.cp.routable(enrollmentId).length === 1, "the workspace becoming routable")
    expect(host.cp.beats().at(-1)?.body.acks).toEqual([{ workspaceId: "ws_1", revision: 1 }])
  })

  test("a slow beat finishes the share instead of timing it out on the startup budget", async () => {
    // The share's bound must cover the beat that carries its ack, not the
    // much tighter budget for spawning a child. 600ms of beat under a 300ms
    // startup budget is that relationship, compressed: the real numbers are a
    // 15s machine request under a 10s startup budget.
    const host = harness({
      startupTimeoutMs: 300,
      beatDelayMs: 600,
      describeWorkspace: async () => ({ displayName: "Claxedo", directory: "/Users/me/test/opencode" }),
    })
    await host.connector.start()
    const enrollmentId = [...host.cp.enrollments.keys()][0]

    const settled = await host.connector.shareWorkspace({ workspaceId: "ws_1" })

    expect(settled).toMatchObject({ status: "enrolled", sharedWorkspaceIds: ["ws_1"] })
    await until(() => host.cp.routable(enrollmentId).length === 1, "the workspace becoming routable")
  })

  test("a share this machine could not describe is refused rather than reported as published", async () => {
    // An assignment with no directory describes nothing, so there is nothing
    // for the machine to consent to and the share has to say so rather than
    // leave a workspace that looks shared and routes nowhere.
    const host = harness({ describeWorkspace: async () => undefined })
    await host.connector.start()
    const enrollmentId = [...host.cp.enrollments.keys()][0]

    await expect(host.connector.shareWorkspace({ workspaceId: "ws_ghost" })).rejects.toThrow(
      /no assignment for this workspace on this machine/,
    )
    expect(host.cp.routable(enrollmentId)).toEqual([])
    expect(host.connector.status()).toMatchObject({ status: "enrolled", sharedWorkspaceIds: [] })
  })

  test("every beat after the enrollment is the machine's own, signed with its key", async () => {
    const host = harness()
    await host.connector.start()

    expect(host.operations.map((operation) => operation.name)).toEqual([
      "host.enrollmentNonce",
      "host.enrollCurrentMachine",
    ])
    expect(host.cp.log.map((entry) => entry.path)).toEqual([
      "/api/claxedo/host/enrollments/acquire",
      "/api/claxedo/host/enrollments/heartbeat",
    ])
    // The fake refuses an unsigned, replayed or mis-signed machine request, so
    // a beat in its log is a beat it verified against the enrolled key.
    expect(host.cp.beats()).toHaveLength(1)
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
    host.children[0].emit({ type: "status", status: { status: "stopped", reason: "closed", detail: "remote stopped" } })
    await until(() => host.connector.status().status === "stopped", "stopped child state")

    await host.connector.start()

    expect(host.children).toHaveLength(2)
    expect(host.children[0].killed).toBe(true)
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
    const secondBootstrap = host.children[1].parentMessages.find((message) => message.type === "bootstrap")
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
      controlPlaneUrl: CONTROL_PLANE_URL,
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

    host.children[0].crash(9)
    await until(() => host.connector.status().status === "stopped", "child exit state")

    expect(host.connector.status()).toMatchObject({ status: "stopped", reason: "error" })
    expect(host.errors.map((entry) => entry.stage)).toContain("child-exit")
    expect(host.statuses).toContainEqual(expect.objectContaining({ status: "stopped", reason: "error" }))
  })

  test("an exit before ready rejects startup instead of leaving it pending", async () => {
    const children: FakeChild[] = []
    const connector = setupHostConnectorChild({
      controlPlaneUrl: CONTROL_PLANE_URL,
      spawn: () => {
        const child = new FakeChild({ autoStart: false })
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
    children[0].crash(17)

    await expect(starting).resolves.toMatchObject({ status: "stopped", reason: "error" })
  })

  test("pause during pre-ready startup resolves immediately as closed", async () => {
    const children: FakeChild[] = []
    const connector = setupHostConnectorChild({
      controlPlaneUrl: CONTROL_PLANE_URL,
      spawn: () => {
        const child = new FakeChild({ autoStart: false })
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
    expect(children[0].killed).toBe(true)
    expect(connector.status()).toMatchObject({ status: "stopped", reason: "closed" })
  })

  test("pause cancels a startup waiting on identity restore", async () => {
    let release!: () => void
    const loading = new Promise<void>((resolve) => {
      release = resolve
    })
    const connector = setupHostConnectorChild({
      controlPlaneUrl: CONTROL_PLANE_URL,
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
    const cp = createFakeControlPlane()
    const children: FakeChild[] = []
    const statuses: unknown[] = []
    const connector = setupHostConnectorChild({
      controlPlaneUrl: CONTROL_PLANE_URL,
      spawn: () => {
        const child = new FakeChild({ fetch: cp.fetch })
        children.push(child)
        return child
      },
      loadIdentity: async () => ({ ok: true }),
      storeIdentity: async () => ({ ok: true }),
      clearIdentity: () => {},
      runAccountOperation: async (name, input) => {
        const hostId = String(input?.hostId)
        if (name === "host.enrollmentNonce") {
          // A nonce POST held open longer than the bootstrap budget: 750ms
          // against 250ms here; live, ~12s against 10s.
          await Bun.sleep(750)
          return { request_id: "req_1", nonce: "nonce_1", expires_at: 9_999 }
        }
        return { enrollment: await cp.enrollAccountHost({ hostId, publicKey: String(input?.publicKey) }) }
      },
      onStatusChange: (status) => statuses.push(status),
      startupTimeoutMs: 250,
      enrollmentTimeoutMs: 10_000,
    })

    const started = await connector.start()
    expect(started).toMatchObject({
      status: "enrolled",
      enrollment: { enrollment_id: [...cp.enrollments.keys()][0] },
    })
    expect(children[0].killed).toBe(false)
    // The bootstrap reply was published while the stall was still open, so a
    // panel open during a slow enrollment sees a starting machine, and
    // everything after it is the enrolled one (the first beat renews the lease
    // and says so, then the handshake announces its outcome).
    expect(statuses[0]).toEqual({ status: "idle" })
    expect(statuses.slice(1)).not.toHaveLength(0)
    for (const status of statuses.slice(1)) expect(status).toMatchObject({ status: "enrolled" })
  })

  test("an enrollment the control plane refuses resolves with the connector's own detail", async () => {
    const children: FakeChild[] = []
    const connector = setupHostConnectorChild({
      controlPlaneUrl: CONTROL_PLANE_URL,
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
      controlPlaneUrl: CONTROL_PLANE_URL,
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
    expect(children[0].killed).toBe(true)
  })

  test("a child that neither becomes ready nor exits is terminated by the startup bound", async () => {
    const children: FakeChild[] = []
    const connector = setupHostConnectorChild({
      controlPlaneUrl: CONTROL_PLANE_URL,
      spawn: () => {
        const child = new FakeChild({ autoStart: false })
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
 * A ~2s control-plane redeploy answers the auth descriptor with 503. The
 * account leaves "signed" and main stops the connector — correctly: never beat
 * with a credential the deployment may have revoked — so the 60s enrollment
 * lease expires and every client is told this machine is offline. Both halves
 * are asserted here: the stop happens, AND a stop nobody chose is undone
 * exactly once when the account returns.
 */
describe("auth-lapse suspension", () => {
  const shares = [{ workspaceId: "ws_1", displayName: "Repo" }] as const

  test("fails closed on auth loss, then restores the machine and its served workspaces", async () => {
    const host = harness({
      sharedWorkspaces: shares,
      describeWorkspace: async () => ({ displayName: "Repo", directory: "/Users/me/repo" }),
    })
    await host.connector.start()
    expect(host.bootstrapOf(0)?.sharedWorkspaces).toEqual(shares)
    const enrollmentId = [...host.cp.enrollments.keys()][0]
    await host.connector.shareWorkspace({ workspaceId: "ws_1", displayName: "Repo" })
    await until(() => host.cp.routable(enrollmentId).length === 1, "the workspace becoming routable")

    // Fail closed. The beat is machine-signed and would go on renewing the
    // lease with no account at all, so stopping the child is the whole of it:
    // the child is gone and the machine is off the air the moment auth lapses.
    expect(host.connector.suspendForAuthLapse()).toBe(true)
    expect(host.children[0].killed).toBe(true)
    expect(host.connector.status()).toEqual({
      status: "stopped",
      reason: "closed",
      detail: HOST_CONNECTOR_AUTH_LAPSE_DETAIL,
    })
    const beatsWhileSuspended = host.cp.beats().length

    const resumed = await host.connector.resumeAfterAuthLapse()

    // The SAME enrollment, because the enroll route upserts on (owner,
    // host_id). A restart that minted a second row would leave this one's
    // generation where it was, and every readiness row below it would read as
    // routing that survived the stop.
    expect(resumed).toMatchObject({ status: "enrolled", enrollment: { enrollment_id: enrollmentId } })
    expect(host.children).toHaveLength(2)
    // The machine comes back publishing what it was publishing, from the list
    // the supervisor already keeps. One load, at construction — a second store
    // would mean a second source of truth.
    expect(host.bootstrapOf(1)?.sharedWorkspaces).toEqual(shares)
    expect(host.shareCounts()).toEqual({ loads: 1, stores: 1 })
    // The resume acquires a new serving generation, and the control plane
    // drops every readiness row below it — so a routable workspace here is a
    // fresh ack by the restarted child, never one that survived the stop.
    await until(() => host.cp.routable(enrollmentId).length === 1, "the workspace becoming routable again")
    expect(host.cp.beats().length).toBeGreaterThan(beatsWhileSuspended)
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

    host.children[0].emit({
      type: "account-operation",
      requestId: "hostile",
      name: "billing.updateSubscription",
      input: { url: "https://attacker.invalid" },
    })
    await Bun.sleep(0)

    expect(host.operations).toHaveLength(before)
    expect(host.children[0].parentMessages.some((message) => message.type === "account-result" && message.requestId === "hostile")).toBe(false)
  })

  test("drops a late account result after revocation without an unhandled transport error", async () => {
    let release!: (value: unknown) => void
    const operation = new Promise<unknown>((resolve) => {
      release = resolve
    })
    const children: FakeChild[] = []
    const errors: Array<{ stage: string; error: unknown }> = []
    const connector = setupHostConnectorChild({
      controlPlaneUrl: CONTROL_PLANE_URL,
      spawn: () => {
        const child = new FakeChild({ autoStart: false })
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
    children[0].emit({ type: "ready" })
    await until(() => children[0].parentMessages.some((message) => message.type === "bootstrap"), "bootstrap")
    children[0].emit({ type: "account-operation", requestId: "late", name: "host.enrollmentNonce", input: { hostId: "h" } })

    connector.revoke()
    release({ request_id: "r", nonce: "n" })
    await starting
    await Bun.sleep(0)

    expect(errors.find((entry) => entry.stage === "child-message")).toBeUndefined()
    expect(children[0].parentMessages.some((message) => message.type === "account-result" && message.requestId === "late")).toBe(false)
  })
})

describe("the owner's name for this machine", () => {
  test("renames the connector's own enrollment, and the next one re-applies it", async () => {
    const host = harness()
    const started = await host.connector.start()
    expect(started.status).toBe("enrolled")

    await expect(host.connector.renameMachine("  Studio Mac  ")).resolves.toEqual({ displayName: "Studio Mac" })

    const rename = host.operations.find((operation) => operation.name === "host.renameCurrentMachine")
    expect(rename?.input).toEqual({
      enrollmentId: started.status === "enrolled" ? started.enrollment.enrollment_id : "",
      displayName: "Studio Mac",
    })
    expect(host.storedName()).toBe("Studio Mac")
    expect(host.connector.displayName()).toBe("Studio Mac")

    // Every enable re-enrols and the enroll route overwrites `display_name`, so
    // a rename that only reached the control plane would be undone here.
    host.connector.stop()
    await host.connector.start()
    expect(host.bootstrapOf(1)?.displayName).toBe("Studio Mac")
  })

  test("refuses an empty name, and refuses to rename a machine that is not enrolled", async () => {
    const host = harness()
    await expect(host.connector.renameMachine("Studio Mac")).rejects.toThrow(/not running/)

    await host.connector.start()
    await expect(host.connector.renameMachine("   ")).rejects.toThrow(/needs a name/)
    expect(host.operations.some((operation) => operation.name === "host.renameCurrentMachine")).toBe(false)
  })
})

describe("provider configuration through main", () => {
  const PROVIDER_CONFIG = JSON.stringify({
    version: 1,
    providers: { "claude-sdk": { baseUrl: "https://broker.test/bindings/b1", placeholder: "sk-1", authMode: "api-key" } },
  })

  test("the ciphertext is stored before the revision is acked, and the opened text reaches the daemon hand-off", async () => {
    // Timer-driven beats: the delivery rides one, the ack rides the next.
    const host = harness({ heartbeatIntervalMs: 20 })
    await host.connector.start()
    const enrollmentId = [...host.cp.enrollments.keys()][0]
    const revision = await host.cp.pushProviderConfig(enrollmentId, PROVIDER_CONFIG)
    await until(() => host.cp.providerConfigAckedRevision(enrollmentId) === revision, "the acked revision")

    expect(host.providerConfigs).toEqual([{ revision, sealed: host.cp.providerConfig(enrollmentId)!.sealed }])
    expect(host.providerConfig()).toEqual(host.providerConfigs[0])
    expect(host.providerReady).toEqual([{ revision, providers: PROVIDER_CONFIG }])
    expect(JSON.stringify(host.providerConfigs)).not.toContain("sk-1")

    // A restart hands the stored revision back to the child, which re-opens it
    // for a daemon that restarted too.
    host.connector.stop()
    await host.connector.start()
    await until(() => host.providerReady.length === 2, "the re-opened revision after the restart")
    expect(host.bootstrapOf(1)).toMatchObject({ providerConfig: { revision } })
    expect(host.providerReady[1]).toEqual({ revision, providers: PROVIDER_CONFIG })
    expect(host.providerConfigs).toHaveLength(1)
    host.connector.dispose()
  })

  test("a store that fails is reported, keeps the revision unacked, and hands the daemon nothing", async () => {
    let storeOk = false
    const host = harness({ heartbeatIntervalMs: 20, storeProviderConfig: () => storeOk })
    await host.connector.start()
    const enrollmentId = [...host.cp.enrollments.keys()][0]
    const revision = await host.cp.pushProviderConfig(enrollmentId, PROVIDER_CONFIG)
    await until(() => host.providerConfigs.length >= 2, "the same revision delivered again")

    expect(host.errors).toContainEqual({ stage: "provider-config-store", error: "safeStorage refused the write" })
    expect(host.providerReady).toEqual([])
    expect(host.providerConfig()).toBeUndefined()
    expect(host.cp.providerConfigAckedRevision(enrollmentId)).not.toBe(revision)

    storeOk = true
    await until(() => host.cp.providerConfigAckedRevision(enrollmentId) === revision, "the acked revision once the store answers")
    expect(host.providerReady).toEqual([{ revision, providers: PROVIDER_CONFIG }])
    host.connector.dispose()
  })
})
