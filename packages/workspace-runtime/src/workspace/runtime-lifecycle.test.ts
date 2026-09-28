import type { AgentExecutionBinding, AgentTurnOutcome, SessionConfig } from "@claxedo/agent-runtime-contract"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { applySessionConfigUpdate, type StartInput } from "@claxedo/harness/contract"
import { RuntimeStore } from "../store"
import { registerWorkspaceDirectory, unregisterWorkspaceDirectory, withWorkspaceTarget } from "../target"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"
import { installFakePiRpc } from "../test-support/home/fake-pi-rpc.mjs"
import { FakeTransport, fakeConnectionProvider } from "../test-support/fake-transport"
import { loopbackMachineLoginPolicy } from "../testing"
import { createWorkspaceHost } from "./runtime"
import type { RuntimeSnapshot } from "../routes/config"

const cleanups: Array<() => void | Promise<void>> = []
const roots: string[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

type FixtureOptions = {
  /** The transport owns session config (`configOwner: "harness"`); the default keeps it in the store. */
  harnessConfig?: boolean
  scoped?: boolean
  hold?: boolean
  holdStart?: boolean
  releaseOnDispose?: boolean
  cancelNeverSettles?: boolean
  /** The first transport's held turn asks a permission the test answers. */
  permission?: boolean
  /** Runs against the store root before the first host opens it. */
  seed?: (storeRoot: string) => void
}

async function fixture(options: FixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "workspace-lifecycle-"))
  roots.push(directory)
  const target = { workspaceId: "workspace-lifecycle", directory }
  const storeRoot = join(directory, "state")
  const executions: AgentExecutionBinding[] = []
  const prompts: string[] = []
  const starts: StartInput[] = []
  const configures: unknown[] = []
  let creates = 0
  let transports = 0
  const disposed: number[] = []
  const resolvedDirectories: string[] = []
  let started = () => {}
  const startedTurn = new Promise<void>((resolve) => { started = resolve })
  let releaseStart = () => {}
  const heldStart = new Promise<void>((resolve) => { releaseStart = resolve })
  const turnReleases = new Map<string, () => void>()
  let released = false
  const release = () => {
    released = true
    releaseStart()
    for (const done of turnReleases.values()) done()
    turnReleases.clear()
  }
  const controls: Array<{ instance: number; action: string }> = []
  const storeLifecycle = { opened: 0, recovered: 0, closed: 0 }
  const capabilities = {
    abort: !!options.hold, reconnect: false, replay: true, permissions: !!options.hold, questions: false,
    todos: false, commands: false, fork: false, revert: false, unrevert: false,
    configOptions: false, subagents: false,
  }
  const provider = fakeConnectionProvider<{ name: string }, { name: string; directory: string }>({
    providerKey: "fixture",
    label: (config) => config.name,
    capabilities,
    validateConfig(input) {
      if (!input || typeof input !== "object" || typeof (input as { name?: unknown }).name !== "string") {
        throw new Error("name is required")
      }
      return input as { name: string }
    },
    resolve({ descriptor, directory }) {
      resolvedDirectories.push(directory)
      return { ...descriptor.config, directory }
    },
    transport({ descriptor, resolved }) {
      const instance = ++transports
      const resolvedDirectory = resolved.config.directory
      const connectionId = "connection:" + descriptor.connectionId
      const configs = new Map<string, SessionConfig>()
      let dead = false
      const alive = () => { if (dead) throw new Error("disposed transport") }
      const transport: FakeTransport = new FakeTransport({
        capabilities: {
          configOwner: options.harnessConfig ? "harness" : "runtime",
          instructionChannel: "none",
          requests: { permissions: !!options.hold, questions: false, elicitation: false },
        },
        ...(options.holdStart ? { beforeStart: async () => { started(); await heldStart } } : {}),
        onStart(input) {
          alive()
          creates++
          starts.push(input)
          configs.set(input.sessionId, input.config)
        },
        turn: async function* ({ session, turn, broker }) {
          alive()
          expect(session.binding).toMatchObject({ workspaceId: target.workspaceId, directory: options.scoped ? resolvedDirectory : directory, connectionId })
          executions.push(session.binding)
          prompts.push(turn.prompt.parts.map((part) => ("text" in part ? part.text : "")).join(""))
          if (options.permission && instance === 1) {
            void broker.ask({
              kind: "permission", requestId: "pending",
              permission: { id: "pending", sessionID: session.binding.sessionId, permission: "tool", patterns: [], metadata: {}, always: [] },
            }).then(() => { controls.push({ instance, action: "permission" }) }, () => {})
          }
          started()
          if (options.hold && !released) await new Promise<void>((resolve) => { turnReleases.set(`${instance}:${session.binding.sessionId}`, resolve) })
          yield { type: "text-delta", delta: "real routed answer" }
          yield { type: "finish", sessionId: session.binding.sessionId }
        },
        cancel: async ({ session }) => {
          controls.push({ instance, action: "cancel" })
          if (options.cancelNeverSettles) return await new Promise<never>(() => {})
          const key = `${instance}:${session.binding.sessionId}`
          turnReleases.get(key)?.()
          turnReleases.delete(key)
          return { execution: "terminal", cleanup: "verified_clear" }
        },
        configure: (update) => { alive(); configures.push(update); return { state: "applied" } },
        ...(options.harnessConfig ? {
          config: {
            read: async (session) => { alive(); return configs.get(session.binding.sessionId)! },
            update: async (session, update) => {
              alive()
              if (update.agent === "rejected") throw new Error("agent rejected")
              const next = applySessionConfigUpdate(configs.get(session.binding.sessionId)!, update)
              configs.set(session.binding.sessionId, next)
              return next
            },
            options: async () => ({ options: [] }),
            permissionModes: async () => ({ modes: [], appliesFrom: "next-turn", unsupported: "fixture has no permission modes" }),
            setPermissionMode: async () => ({ modes: [], appliesFrom: "next-turn", unsupported: "fixture has no permission modes" }),
          },
        } : {}),
        // It is the transport that drains the starts and turns it still runs
        // before its disposal answers.
        onDispose: async () => {
          if (options.releaseOnDispose) release()
          while (transport.activeStarts > 0 || transport.activeTurns > 0) await new Promise((resolve) => setTimeout(resolve, 5))
          dead = true
          disposed.push(instance)
        },
      })
      return transport
    },
  })
  const snapshot = (name = "agent", revision = 1): RuntimeSnapshot => ({
    version: 4, mcp: {}, auth: { machineOwnerUserId: "local", accounts: { local: {} } },
    connections: ["primary", "secondary"].map((connectionId) => ({
      connectionId, providerKey: "fixture", configRevision: revision, enabled: true, config: { name },
    })),
    defaultHarness: { kind: "connection", connectionId: "primary" },
  })
  let secretLease = "one"
  const rotateSecretLease = (next: string) => { secretLease = next }
  options.seed?.(storeRoot)
  function open() {
    const host = createWorkspaceHost({ placement: loopbackMachineLoginPolicy(), target, storeRoot, connectionProviders: [provider], resolveConnectionSecrets: () => ({ secrets: { token: secretLease }, secretLeaseGeneration: secretLease }), storeFactory: ({ storeRoot }) => {
      const store = new RuntimeStore(storeRoot)
      storeLifecycle.opened++
      const recover = store.recoverBusySessions.bind(store)
      const close = store.close.bind(store)
      store.recoverBusySessions = () => { storeLifecycle.recovered++; return recover() }
      store.close = () => { storeLifecycle.closed++; return close() }
      return store
    } })
    cleanups.push(() => host.dispose())
    const app = new Hono()
    host.mount(app, { exposure: loopbackWorkspaceRuntimeExposure() })
    const request = (pathname: string, method = "GET", body?: unknown, query = "", requestDirectory = directory) =>
      withWorkspaceTarget(target, () => app.request(
        "http://runtime.test" + pathname + "?directory=" + encodeURIComponent(requestDirectory) + query,
        { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) },
      ))
    return { host, request }
  }
  return { ...open(), open, snapshot, rotateSecretLease, target, storeRoot, executions, prompts, starts, configures, disposed, resolvedDirectories, startedTurn, release, controls, storeLifecycle, creates: () => creates, transports: () => transports }
}

/**
 * Cancel the session's admitted turn the way a caller must: read the identity
 * from the owner that minted it, then send it back unchanged. A request naming
 * only the session would reach whatever is running when it arrives.
 */
async function cancelAdmittedTurn(
  f: { request: (pathname: string, method?: string, body?: unknown) => Promise<Response> | Response },
  sessionId: string,
) {
  const inspected = await (await f.request(`/session/${sessionId}/recovery`)).json() as { target?: { ownerGeneration: string } }
  expect(inspected.target, "the session has an admitted turn to cancel").toBeDefined()
  return await f.request(`/session/${sessionId}/recovery`, "POST", {
    requestId: `lifecycle-cancel:${sessionId}:${inspected.target!.ownerGeneration}`,
    action: "cancel_turn",
    target: inspected.target,
    scopeRevision: inspected.target!.ownerGeneration,
    attempt: 1,
  })
}

describe("workspace runtime public lifecycle", () => {
  for (const selection of ["primary", "secondary", "default"] as const) {
    test(`${selection} create returns the persisted title and workspace identity`, async () => {
      const f = await fixture({ harnessConfig: true })
      await f.host.apply(f.snapshot())
      const title = "Named session café 日本語"
      const response = await f.request("/session", "POST", { id: "named", title }, selection === "default" ? "" : `&connectionId=${selection}`)
      expect(response.status).toBe(201)
      const created = await response.json()
      expect(created).toMatchObject({ id: "named", title, directory: f.target.directory, workspaceId: f.target.workspaceId })
      expect(await (await f.request("/session/named")).json()).toMatchObject({ id: "named", title })
      await f.host.dispose()
      const reopened = f.open()
      expect(await (await reopened.request("/session/named")).json()).toMatchObject({ id: "named", title })
    })
  }

  test("lazy admission hands the empty configuration to each session start and never as a separate push", async () => {
    const f = await fixture()
    const snapshot = f.snapshot()
    delete snapshot.defaultHarness
    await f.host.apply(snapshot)
    expect(f.transports()).toBe(0)
    expect((await f.request("/session", "POST", { id: "first" }, "&connectionId=primary")).status).toBe(201)
    expect(f.starts).toHaveLength(1)
    expect(f.starts[0]).toMatchObject({
      config: { harness: { id: "primary", access: "connection" } },
      projection: { generation: "runtime-config:1", mcpServers: [], pluginRoots: [], notApplied: [] },
      credentials: { machineLoginAllowed: true, accountOwner: "local", providers: {}, secrets: {}, leaseGeneration: "runtime-config:1" },
    })
    expect((await f.request("/session", "POST", { id: "second" }, "&connectionId=primary")).status).toBe(201)
    expect(f.starts).toHaveLength(2)
    expect(f.starts[1].credentials).toEqual(f.starts[0].credentials)
    expect(f.configures).toEqual([])
  })
  test("shutdown unblocks a pending create through transport teardown before closing the store", async () => {
    const f = await fixture({ holdStart: true, releaseOnDispose: true })
    await f.host.apply(f.snapshot())
    const create = f.request("/session", "POST", { id: "creating" })
    await f.startedTurn
    const shutdown = await Promise.race([
      f.host.dispose().then(() => "disposed" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 5_000)),
    ])
    expect(shutdown).toBe("disposed")
    expect((await create).status).toBe(201)
    expect(f.storeLifecycle).toEqual({ opened: 1, recovered: 1, closed: 1 })
    expect((await f.request("/session")).status).toBe(503)
  })

  test("source retirement after handoff leaves the target's active turn and transport alive", async () => {
    const f = await fixture({ hold: true })
    await f.host.apply(f.snapshot())
    await f.request("/session", "POST", { id: "handoff" })
    const config = await f.request("/session/handoff/config", "PATCH", { harness: { id: "secondary", access: "connection" } })
    expect(config.status, await config.clone().text()).toBe(200)
    const prompt = f.request("/session/handoff/message", "POST", { parts: [{ type: "text", text: "target" }] })
    try {
      await f.startedTurn
      const removed = f.snapshot()
      removed.connections = removed.connections.filter((row) => row.connectionId !== "primary")
      removed.defaultHarness = { kind: "connection", connectionId: "secondary" }
      await f.host.apply(removed)
      expect(f.controls).toEqual([])
      expect((await f.request("/session/handoff/config")).status).toBe(200)
      f.release()
      expect((await prompt).status).toBe(200)
      expect(f.executions.at(-1)?.connectionId).toBe("connection:secondary")
      const second = await f.request("/session/handoff/message", "POST", { parts: [{ type: "text", text: "still alive" }] })
      expect(second.status, await second.clone().text()).toBe(200)
      expect(f.executions).toHaveLength(2)
    } finally { f.release(); await prompt }
  })

  test("shutdown drains an admitted prompt before closing and never reopens its store", async () => {
    const f = await fixture({ hold: true, releaseOnDispose: true })
    await f.host.apply(f.snapshot())
    await f.request("/session", "POST", { id: "local" })
    const prompt = f.request("/session/local/message", "POST", { parts: [{ type: "text", text: "wait" }] })
    await f.startedTurn
    const shutdown = f.host.dispose()
    try {
      expect(f.storeLifecycle.closed).toBe(0)
      expect((await f.request("/session")).status).toBe(503)
    } finally { f.release(); await prompt; await shutdown }
    expect(f.storeLifecycle).toEqual({ opened: 1, recovered: 1, closed: 1 })
    expect((await f.request("/session")).status).toBe(503)
    await f.host.dispose()
    expect(f.storeLifecycle.closed).toBe(1)
  })

  test("retiring a used connection preserves the host store and other sessions", async () => {
    const f = await fixture()
    const first = f.snapshot()
    first.connections[0].secretRefs = { token: "credential" }
    await f.host.apply(first)
    await f.request("/session", "POST", { id: "local" })
    expect((await f.request("/session/local/message", "POST", { parts: [{ type: "text", text: "first" }] })).status).toBe(200)
    f.rotateSecretLease("two")
    const response = await f.request("/session/local/message", "POST", { parts: [{ type: "text", text: "second" }] })
    expect(response.status, await response.clone().text()).toBe(200)
    expect((await f.request("/session")).status).toBe(200)
    expect(f.storeLifecycle).toEqual({ opened: 1, recovered: 1, closed: 0 })
    await f.host.dispose()
    await f.host.dispose()
    expect(f.storeLifecycle.closed).toBe(1)
  })

  test("connection-only restart releases stale durable turn leases before prompting", async () => {
    const f = await fixture()
    await f.host.apply(f.snapshot())
    await f.request("/session", "POST", { id: "local" })
    await f.host.dispose()
    const crashed = new RuntimeStore(f.storeRoot)
    expect(crashed.acquireTurnLease("local")).toBeDefined()
    crashed.close()
    const restored = f.open()
    await restored.host.apply(f.snapshot())
    const response = await restored.request("/session/local/message", "POST", { parts: [{ type: "text", text: "resume" }] })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(f.executions).toHaveLength(1)
  })

  test("changing the default keeps an existing session transport usable", async () => {
    const f = await fixture()
    await f.host.apply(f.snapshot())
    await f.request("/session", "POST", { id: "local" })
    const next = f.snapshot()
    next.defaultHarness = { kind: "connection", connectionId: "secondary" }
    await f.host.apply(next)
    const response = await f.request("/session/local/message", "POST", { parts: [{ type: "text", text: "old selection" }] })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(f.executions).toHaveLength(1)
    expect((await f.request("/session", "POST", { id: "new-default" })).status).toBe(201)
    expect((await f.request("/session/new-default/message", "POST", { parts: [{ type: "text", text: "new selection" }] })).status).toBe(200)
    expect(f.executions.map((binding) => binding.connectionId)).toEqual(["connection:primary", "connection:secondary"])
  })

  test("removing a configured connection retires it before config fanout", async () => {
    const f = await fixture({ harnessConfig: true })
    await f.host.apply(f.snapshot())
    await f.request("/session", "POST", { id: "secondary" }, "&connectionId=secondary")
    const removed = f.snapshot()
    removed.connections = removed.connections.filter((row) => row.connectionId !== "secondary")
    await f.host.apply(removed)
    expect(f.host.detail().state).toBe("ready")
    expect((await f.request("/session", "POST", { id: "healthy" })).status).toBe(201)
  })

  test("credential rotation keeps active permission and cancellation controls on the executing generation", async () => {
    const f = await fixture({ hold: true, permission: true })
    cleanups.push(f.release)
    const first = f.snapshot()
    first.connections[0].secretRefs = { token: "credential" }
    await f.host.apply(first)
    await f.request("/session", "POST", { id: "local" })
    const prompt = f.request("/session/local/message", "POST", { parts: [{ type: "text", text: "wait" }] })
    try {
      await f.startedTurn
      f.rotateSecretLease("two")
      expect((await f.request("/session", "POST", { id: "new-generation" })).status).toBe(201)
      expect(f.disposed).not.toContain(1)
      const permission = await f.request("/session/local/permissions/pending", "POST", { response: "once" })
      expect(permission.status, await permission.clone().text()).toBe(200)
      expect((await cancelAdmittedTurn(f, "local")).status).toBe(200)
      expect(f.controls).toEqual([{ instance: 1, action: "permission" }, { instance: 1, action: "cancel" }])
      expect((await prompt).status).toBe(200)
    } finally {
      f.release()
      await prompt
    }
  })

  test("removed active connections remain controllable until the turn releases its generation", async () => {
    const f = await fixture({ hold: true })
    await f.host.apply(f.snapshot())
    await f.request("/session", "POST", { id: "local" })
    const prompt = f.request("/session/local/message", "POST", { parts: [{ type: "text", text: "wait" }] })
    try {
      await f.startedTurn
      const next = f.snapshot()
      next.connections = next.connections.filter((row) => row.connectionId !== "primary")
      next.defaultHarness = { kind: "connection", connectionId: "secondary" }
      await f.host.apply(next)
      expect(f.disposed).not.toContain(1)
      expect((await cancelAdmittedTurn(f, "local")).status).toBe(200)
      expect(f.controls).toEqual([{ instance: 1, action: "cancel" }])
      expect((await prompt).status).toBe(200)
      for (let flush = 0; flush < 100 && !f.disposed.includes(1); flush++) await new Promise((resolve) => setTimeout(resolve, 5))
      expect(f.disposed.filter((instance) => instance === 1)).toHaveLength(1)
      expect(f.storeLifecycle.closed).toBe(0)
      expect((await f.request("/session", "POST", { id: "healthy" })).status).toBe(201)
    } finally {
      f.release()
      await prompt
    }
  })

  test("connection resolution follows a registered session worktree without retiring the root transport", async () => {
    const f = await fixture({ scoped: true })
    const worktree = join(f.target.directory, "worktree")
    registerWorkspaceDirectory({ workspaceId: f.target.workspaceId, sessionId: "worktree", directory: worktree })
    cleanups.push(() => unregisterWorkspaceDirectory({ workspaceId: f.target.workspaceId, sessionId: "worktree" }))
    await f.host.apply(f.snapshot())
    await f.request("/session", "POST", { id: "root" })
    expect((await f.request("/session", "POST", { id: "worktree" }, "", worktree)).status).toBe(201)
    const response = await f.request("/session/worktree/message", "POST", { parts: [{ type: "text", text: "worktree" }] }, "", worktree)
    expect(response.status, await response.clone().text()).toBe(200)
    expect(f.resolvedDirectories).toContain(worktree)
    expect(f.disposed).not.toContain(1)
    expect((await f.request("/session/root/message", "POST", { parts: [{ type: "text", text: "root" }] })).status).toBe(200)
  })

  test("empty inventory and status never select or compose a harness", async () => {
    const f = await fixture({ harnessConfig: true })
    expect(await (await f.request("/session")).json()).toEqual([])
    expect(await (await f.request("/session/status")).json()).toEqual({})
    expect((await f.request("/session/missing")).status).toBe(404)
    expect(f.transports()).toBe(0)
  })

  test("a deleted session remains not found without a configured default harness", async () => {
    const f = await fixture({ harnessConfig: true })
    const snapshot = f.snapshot()
    delete snapshot.defaultHarness
    await f.host.apply(snapshot)
    expect((await f.request("/session", "POST", { id: "deleted" }, "&connectionId=primary")).status).toBe(201)
    expect((await f.request("/session/deleted", "DELETE")).status).toBe(200)
    expect((await f.request("/session/deleted")).status).toBe(404)
  })

  test("deleting an active session retires its host turn before removing its binding", async () => {
    const f = await fixture({ hold: true })
    await f.host.apply(f.snapshot())
    await f.request("/session", "POST", { id: "local" })
    await f.request("/session", "POST", { id: "neighbor" })
    const prompt = f.request("/session/local/message", "POST", { parts: [{ type: "text", text: "wait" }] })
    await f.startedTurn
    try {
      expect((await f.request("/session/neighbor/prompt_async", "POST", { parts: [{ type: "text", text: "keep waiting" }] })).status).toBe(204)
      expect(f.host.activity().activeTurns).toBe(2)
      expect((await f.request("/session/local", "DELETE")).status).toBe(200)
      expect(f.host.activity().activeTurns).toBe(1)
      expect((await f.request("/session/local")).status).toBe(404)
      expect((await f.request("/session/neighbor")).status).toBe(200)
      expect(f.controls).toHaveLength(1)
    } finally {
      f.release()
      await prompt
    }
  })

  test("create, config, prompt and history share the canonical execution binding", async () => {
    const f = await fixture()
    await f.host.apply(f.snapshot())
    expect((await f.request("/session", "POST", { id: "local" })).status).toBe(201)
    expect((await f.request("/session/local/config", "PATCH", { agent: "review" })).status).toBe(200)
    const config = await (await f.request("/session/local/config")).json()
    expect(config).toMatchObject({ agent: "review" })
    expect(f.host.getSessionConfig("local")).toEqual(config)
    expect(f.host.getSessionConfig("missing")).toBeUndefined()
    const response = await f.request("/session/local/message", "POST", {
      messageID: "prompt-one", parts: [{ type: "text", text: "hello" }],
    })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(f.executions).toEqual([{
      sessionId: "local", directory: f.target.directory, workspaceId: f.target.workspaceId,
      connectionId: "connection:primary", upstreamSessionId: "upstream-local",
    }])
    const history = await (await f.request("/session/local/message")).json()
    expect(JSON.stringify(history)).toContain("real routed answer")
    const snapshot = await (await f.request("/session/local/message", "GET", undefined, "&snapshot=1")).json()
    expect(snapshot.maxEventOrdinal).toBeGreaterThan(0)
    for (const query of ["", "&view=latest-surface", "&view=latest-turn", "&limit=1"]) {
      const response = await f.request("/session/local/message", "GET", undefined, query)
      expect(response.status).toBe(200)
      expect(response.headers.get("x-max-event-ordinal")).toBe(String(snapshot.maxEventOrdinal))
      expect(response.headers.get("access-control-expose-headers")).toContain("X-Max-Event-Ordinal")
      expect(JSON.stringify(await response.json())).toContain("real routed answer")
    }
    expect((await f.request("/session/missing")).status).toBe(404)
  })

  test("retries are idempotent and cannot reassign an existing session to another connection", async () => {
    const f = await fixture({ harnessConfig: true })
    await f.host.apply(f.snapshot())
    expect((await f.request("/session", "POST", { id: "local" })).status).toBe(201)
    expect((await f.request("/session", "POST", { id: "local" })).status).toBe(201)
    expect(f.creates()).toBe(1)
    const switched = await f.request("/session", "POST", { id: "local" }, "&connectionId=secondary")
    expect(switched.status).toBe(409)
    expect(f.creates()).toBe(1)
    expect(await (await f.request("/session/local/config")).json()).toMatchObject({ harness: { id: "primary" } })
  })

  test("a config the harness rejects is not persisted", async () => {
    const f = await fixture({ harnessConfig: true })
    await f.host.apply(f.snapshot())
    await f.request("/session", "POST", { id: "local" })
    expect((await f.request("/session/local/config", "PATCH", { agent: "accepted" })).status).toBe(200)
    expect((await f.request("/session/local/config", "PATCH", { agent: "rejected" })).status).toBe(500)
    expect(await (await f.request("/session/local/config")).json()).toMatchObject({ agent: "accepted" })
  })

  test("inventory and upstream binding survive close/reopen without discovery", async () => {
    const f = await fixture()
    await f.host.apply(f.snapshot())
    await f.request("/session", "POST", { id: "local" })
    await f.request("/session/local", "PATCH", { title: "Saved title" })
    await f.host.dispose()
    const before = f.transports()
    const restored = f.open()
    const inventory = await (await restored.request("/session")).json()
    expect(inventory).toMatchObject([{ id: "local", title: "Saved title" }])
    expect(f.transports()).toBe(before)
    await restored.host.apply(f.snapshot())
    expect((await restored.request("/session/local/message", "POST", {
      messageID: "restored-prompt", parts: [{ type: "text", text: "continue" }],
    })).status).toBe(200)
    expect(f.executions.at(-1)?.upstreamSessionId).toBe("upstream-local")
    expect(f.creates()).toBe(1)
  })

  test("failed connection validation preserves the previously applied config", async () => {
    const f = await fixture({ harnessConfig: true })
    await f.host.apply(f.snapshot("valid"))
    const invalid = f.snapshot("invalid", 2)
    invalid.connections[0].config = {}
    await expect(f.host.apply(invalid)).rejects.toThrow()
    expect(f.host.detail().harness).toEqual({ kind: "connection", connectionId: "primary" })
    expect((await f.request("/session", "POST", { id: "after-error" })).status).toBe(201)
  })

  test("metadata events update known rows without importing sessions or moving their binding", async () => {
    const f = await fixture()
    const store = new RuntimeStore(f.storeRoot)
    cleanups.push(() => store.close())
    store.bindSession({
      sessionId: "local", directory: f.target.directory, workspaceId: f.target.workspaceId,
      connectionId: "connection:primary", agentSessionId: "upstream-local", upstreamSessionId: "upstream-local",
    })
    store.appendEvent({ sessionId: "local", payload: {
      id: "metadata", type: "session.updated",
      properties: { sessionID: "local", info: { id: "local", title: "Changed" } },
    } })
    expect(store.getSession("local")).toMatchObject({ title: "Changed", directory: f.target.directory })
    expect(store.getExecutionBinding("local")?.upstreamSessionId).toBe("upstream-local")
    store.appendEvent({ sessionId: "unbound", payload: {
      id: "unbound-metadata", type: "session.updated",
      properties: { sessionID: "unbound", info: { id: "unbound", title: "Do not import" } },
    } })
    expect(store.getSession("unbound")).toBeNull()
  })
  test("a prompt the previous process left queued starts as the runtime boots, with no request", async () => {
    // Only a native default is runnable before any snapshot, so the harness
    // that answers at boot is the scripted Pi, and the session it resumes is
    // one the previous process created for real.
    const peer = await installFakePiRpc()
    cleanups.push(() => peer.dispose())
    const directory = await mkdtemp(join(tmpdir(), "workspace-queued-boot-"))
    roots.push(directory)
    const storeRoot = join(directory, "state")
    const harnessStateRoot = join(directory, "harness")
    const target = { workspaceId: "ws-queued", directory }
    const outcomes: Array<{ sessionId: string; outcome: AgentTurnOutcome }> = []
    const boot = (onTurnOutcome?: (input: { sessionId: string; outcome: AgentTurnOutcome }) => void) => {
      const host = createWorkspaceHost({
        placement: loopbackMachineLoginPolicy(), target, storeRoot, harnessStateRoot,
        env: { ...process.env, PI_EXECUTABLE: peer.binary },
        harness: { kind: "native", harnessId: "pi" },
        ...(onTurnOutcome ? { onTurnOutcome } : {}),
      })
      cleanups.push(() => host.dispose())
      const app = new Hono()
      host.mount(app, { exposure: loopbackWorkspaceRuntimeExposure() })
      const request = (pathname: string, method = "GET", body?: unknown) => withWorkspaceTarget(target, () => app.request(
        `http://runtime.test${pathname}?directory=${encodeURIComponent(directory)}`,
        { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) },
      ))
      return { host, request }
    }

    const previous = boot()
    const created = await previous.request("/session", "POST", { id: "local", model: { providerID: "pi", modelID: "test/model" } })
    expect(created.status, await created.clone().text()).toBe(201)
    await previous.host.dispose()
    const died = new RuntimeStore(storeRoot)
    died.queuePrompt({ sessionId: "local", messageId: "msg_queued", parts: [{ type: "text", text: "then run the tests" }], delivery: "queue" })
    died.close()

    const restarted = boot((input) => outcomes.push(input))
    await until(() => outcomes.length > 0)
    expect(outcomes).toEqual([expect.objectContaining({ sessionId: "local", assistantMessageId: "msg_queued_r", outcome: expect.objectContaining({ status: "completed" }) })])
    const history = JSON.stringify(await (await restarted.request("/session/local/message")).json())
    expect(history).toContain("then run the tests")
    expect(history).toContain("work done")
    await restarted.host.dispose()
    const drained = new RuntimeStore(storeRoot)
    cleanups.push(() => drained.close())
    expect(drained.listQueuedPrompts()).toEqual([])
  })

  test("a runtime that learns its harness from a config snapshot re-issues the queue when it applies", async () => {
    const f = await fixture({ seed: queuedPromptLeftBehind })
    expect(f.prompts).toEqual([])

    await f.host.apply(f.snapshot())

    await until(() => f.prompts.length > 0)
    expect(f.prompts).toEqual(["then run the tests"])
    expect(f.executions.map((binding) => binding.sessionId)).toEqual(["local"])
  })
  test("a cancellation that never settles leaves the freeze blocked, naming the turn, with writes still gated", async () => {
    const f = await fixture({ hold: true, cancelNeverSettles: true })
    await f.host.apply(f.snapshot())
    await f.request("/session", "POST", { id: "local" })
    const prompt = f.request("/session/local/message", "POST", { parts: [{ type: "text", text: "wait" }] })
    try {
      await f.startedTurn
      const result = await f.host.checkpoint.freeze("interrupt", { deadlineAt: Date.now() + 100 })

      expect(result.state).toBe("blocked")
      expect(result.state === "blocked" && result.blockers).toEqual([
        { sessionId: "local", turnId: expect.any(String), reason: "cancel_deadline_exceeded" },
      ])
      expect(f.controls).toEqual([{ instance: 1, action: "cancel" }])
      // The gate it could not verify stays closed: the turn is still running,
      // so nothing here established that a writer may be admitted.
      expect(f.host.checkpoint.detail().state).toBe("freezing")
      expect(f.host.checkpoint.beginWrite()).toBeUndefined()
    } finally {
      f.release()
      await prompt
    }
  })
  test("a closing runtime still serves recovery, and only that lets its disposal finish", async () => {
    const f = await fixture({ hold: true })
    await f.host.apply(f.snapshot())
    await f.request("/session", "POST", { id: "local" })
    const prompt = f.request("/session/local/message", "POST", { parts: [{ type: "text", text: "wait" }] })
    try {
      await f.startedTurn
      const inspected = await (await f.request("/session/local/recovery")).json() as { target?: { ownerGeneration: string } }
      expect(inspected.target).toBeDefined()

      // Disposal is now waiting on the held prompt request, and only a
      // cancellation ends that turn. If recovery were refused while closing,
      // or drained as one of the requests disposal waits for, this could never
      // finish: the containment and the teardown it contains would each be
      // waiting for the other.
      const disposal = f.host.dispose()
      expect((await f.request("/session", "POST", { id: "after-close" })).status).toBe(503)

      const cancelled = await f.request("/session/local/recovery", "POST", {
        requestId: "closing-cancel",
        action: "cancel_turn",
        target: inspected.target,
        scopeRevision: inspected.target!.ownerGeneration,
        attempt: 1,
      })
      expect(cancelled.status, await cancelled.clone().text()).toBe(200)
      expect(f.controls).toEqual([{ instance: 1, action: "cancel" }])

      const outcome = await Promise.race([
        disposal.then(() => "disposed" as const),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 5_000)),
      ])
      expect(outcome).toBe("disposed")
    } finally {
      f.release()
      await prompt
    }
  })
  test("the host names each admitted turn, and refuses to report launches once it is closing", async () => {
    const f = await fixture({ hold: true })
    await f.host.apply(f.snapshot())
    await f.request("/session", "POST", { id: "local" })
    expect(f.host.activeTurns(), "no turn is admitted yet").toEqual([])
    const prompt = f.request("/session/local/message", "POST", { parts: [{ type: "text", text: "wait" }] })
    try {
      await f.startedTurn

      const turns = f.host.activeTurns()
      expect(turns).toHaveLength(1)
      expect(turns[0]).toMatchObject({ scope: "turn", sessionId: "local" })
      expect(turns[0]?.turnId).toEqual(expect.any(String))
      expect(turns[0]?.ownerGeneration).toEqual(expect.any(String))
      // The same identity the session's own recovery inspection reports.
      const inspected = await (await f.request("/session/local/recovery")).json() as { target?: unknown }
      expect(JSON.parse(JSON.stringify(turns[0]))).toEqual(inspected.target)

      // Nothing prepared a launch, and that is a different answer from being
      // unable to say.
      expect(await f.host.unresolvedLaunches()).toEqual([])
    } finally {
      f.release()
      await prompt
    }
    await f.host.dispose()
    expect(f.host.activeTurns()).toEqual([])
    await expect(f.host.unresolvedLaunches()).rejects.toThrow()
  })
  test("a launch a previous owner never settled keeps writes out until an operator resolves it", async () => {
    const f = await fixture()
    // What a crash leaves: a direct launch whose spawn was never witnessed and
    // for which no creation identity was recorded, so nothing the replacement
    // can check establishes whether that process is still running.
    const seeded = new RuntimeStore(f.storeRoot)
    const previousOwner = { ownerGeneration: "previous-owner-generation", scope: { kind: "workspace" as const, workspaceId: f.target.workspaceId } }
    const prepared = await seeded.launchOwnership(previousOwner).prepare({
      role: "terminal",
      protocol: "direct",
    })
    seeded.close()

    // No wait here on purpose: ingress is what must not admit a write before
    // reconciliation has settled, so the request itself proves the gate.
    const replacement = f.open()
    const refused = await replacement.request("/session", "POST", { id: "after-crash" })
    expect(refused.status, await refused.clone().text()).toBe(503)
    const body = await refused.json() as { error?: string }
    expect(body.error).toContain("workspace_launch_unreconciled")
    expect(body.error).toContain(prepared.launchId)
    // A read is not a write: inspecting the workspace is how an operator finds
    // out what is holding it.
    expect((await replacement.request("/session")).status).toBe(200)
    expect(replacement.host.activity().launches).toMatchObject({ examined: 1, retired: 0, unresolved: 1 })

    const resolving = new RuntimeStore(f.storeRoot)
    await resolving.launchOwnership(previousOwner).recordRetirement(prepared.launchId, {
      leader: "exited",
      descendants: "verified_clear",
      signals: [],
    })
    resolving.close()

    const resolved = f.open()
    await resolved.host.apply(f.snapshot())
    expect((await resolved.request("/session", "POST", { id: "after-resolution" })).status).toBe(201)
    expect(resolved.host.activity().launches).toMatchObject({ examined: 0, retired: 0, unresolved: 0 })
  })

})

/** A store left behind by a process that died holding a queued prompt on the fixture's primary connection. */
function queuedPromptLeftBehind(storeRoot: string) {
  const directory = join(storeRoot, "..")
  const died = new RuntimeStore(storeRoot)
  died.bindSession({
    sessionId: "local", directory, workspaceId: "workspace-lifecycle",
    connectionId: "connection:primary", agentSessionId: "upstream-local", upstreamSessionId: "upstream-local",
  })
  died.recordSessionOwner("local", { kind: "machine-owner" })
  died.updateSessionConfig("local", {
    harness: { id: "primary", access: "connection" }, model: null, variant: null, agent: null,
  }, { directory })
  died.queuePrompt({
    sessionId: "local",
    messageId: "msg_queued",
    parts: [{ type: "text", text: "then run the tests" }],
    delivery: "queue",
  })
  died.close()
}

async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 400 && !condition(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  if (!condition()) throw new Error("condition never held")
}
