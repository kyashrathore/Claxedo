import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import type { AgentExecutionBinding } from "@claxedo/agent-runtime-contract"
import { NO_HARNESS_EFFORT } from "@claxedo/agent-runtime-contract"
import type { AgentSession, ConnectionProvider, SessionConfig } from "@claxedo/agent-sdk-runtime"
import type { AgentHarnessAdapter } from "@claxedo/agent-sdk-runtime/adapters"
import { RuntimeStore } from "../store"
import { registerWorkspaceDirectory, unregisterWorkspaceDirectory, withWorkspaceTarget } from "../target"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"
import { createWorkspaceHost, defaultWorkspaceHarnessRegistry } from "./runtime"
import type { RuntimeSnapshot } from "../routes/config"

const cleanups: Array<() => void | Promise<void>> = []
const roots: string[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(options: { runtimeConfig?: boolean; configurable?: boolean; scoped?: boolean; native?: boolean; hold?: boolean; holdCreate?: boolean; releaseOnDispose?: boolean; cancelNeverSettles?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "workspace-lifecycle-"))
  roots.push(directory)
  const target = { workspaceId: "workspace-lifecycle", directory }
  const storeRoot = join(directory, "state")
  const upstream = new Map<string, AgentSession>()
  const configs = new Map<string, SessionConfig>()
  const executions: AgentExecutionBinding[] = []
  let creates = 0
  let adapters = 0
  const disposed: number[] = []
  const resolvedDirectories: string[] = []
  let release = () => {}
  let started = () => {}
  const startedTurn = new Promise<void>((resolve) => { started = resolve })
  const heldTurn = new Promise<void>((resolve) => { release = resolve })
  const releaseCreate = release
  const turnReleases = new Map<string, () => void>()
  let released = false
  release = () => {
    released = true
    releaseCreate()
    for (const done of turnReleases.values()) done()
    turnReleases.clear()
  }
  const controls: Array<{ instance: number; action: string }> = []
  const configurations: unknown[] = []
  const storeLifecycle = { opened: 0, recovered: 0, closed: 0 }
  const capabilities = {
    abort: !!options.hold, reconnect: false, replay: true, permissions: !!options.hold, questions: false,
    todos: false, commands: false, fork: false, revert: false, unrevert: false,
    configOptions: false, subagents: false,
  }
  const provider: ConnectionProvider<{ name: string }> = {
    providerKey: "fixture",
    validateConfig(input) {
      if (!input || typeof input !== "object" || typeof (input as { name?: unknown }).name !== "string") {
        throw new Error("name is required")
      }
      return input as { name: string }
    },
    project(config) { return { label: config.name, readiness: "ready", capabilities } },
    resolve({ descriptor, directory }) {
      resolvedDirectories.push(directory)
      return { config: { ...descriptor.config, directory } }
    },
    createAdapter({ descriptor, resolved }) {
      const instance = ++adapters
      const resolvedDirectory = (resolved.config as { directory?: string }).directory
      let dead = false
      const native = descriptor.providerKey === "native-fixture"
      const harness = { id: descriptor.connectionId, access: native ? "native" as const : "connection" as const }
      const read = (binding: AgentExecutionBinding) => {
        if (dead) throw new Error("disposed adapter")
        expect(binding).toMatchObject({ workspaceId: target.workspaceId, ...(options.scoped ? { directory: resolvedDirectory } : { directory }), connectionId: (native ? "native:" : "connection:") + descriptor.connectionId })
        return upstream.get(binding.upstreamSessionId) ?? null
      }
      return {
        ...(options.configurable ? { adapterCapabilities: ["runtime-config"] as const, setModel() {}, async applyConfig(config: unknown) { if (dead) throw new Error("disposed adapter"); configurations.push(config) } } : {}),
        sessionConfigOwner: options.runtimeConfig ? "runtime" : "adapter",
        instructionChannel: "none" as const,
        async createSession(_directory, title, id) {
          if (options.holdCreate) { started(); await heldTurn }
          creates++
          const sessionId = id ?? "generated"
          const upstreamId = "upstream-" + sessionId
          upstream.set(upstreamId, { id: sessionId, title, directory, time: { created: 10, updated: 10 } })
          configs.set(sessionId, { harness, agent: null, variant: null })
          return { id: sessionId, agentSessionId: upstreamId }
        },
        async createHandoffSession(_directory, title, id) {
          const upstreamId = `handoff-${descriptor.connectionId}-${id}`
          upstream.set(upstreamId, { id, title, directory, time: { created: 10, updated: 10 } })
          configs.set(id, { harness, agent: null, variant: null })
          return { id, agentSessionId: upstreamId, rollback: async () => { upstream.delete(upstreamId) } }
        },
        async getSession(binding) { return read(binding) },
        async getMessages(binding) { read(binding); return [] },
        async updateSession(binding, update) {
          const session = read(binding)
          if (!session) return null
          const next = { ...session, ...update, time: { ...session.time!, ...update.time } }
          upstream.set(binding.upstreamSessionId, next)
          return next
        },
        async deleteSession(binding) { read(binding); upstream.delete(binding.upstreamSessionId) },
        async getSessionConfig(binding) {
          if (options.runtimeConfig) throw new Error("config is runtime-owned")
          read(binding)
          return configs.get(binding.sessionId)!
        },
        async updateSessionConfig(binding, update) {
          if (options.runtimeConfig) throw new Error("config is runtime-owned")
          read(binding)
          if (update.agent === "rejected") throw new Error("agent rejected")
          const current = configs.get(binding.sessionId)!
          const next = { ...current, ...update, permissionState: update.permissionState === null ? undefined : update.permissionState ?? current.permissionState, permissionMode: update.permissionMode === null ? undefined : update.permissionMode ?? current.permissionMode, model: update.model === null ? undefined : update.model ?? current.model }
          configs.set(binding.sessionId, next)
          return next
        },
        async *executeTurn(binding) {
          read(binding)
          executions.push(binding)
          started()
          if (options.hold && !released) await new Promise<void>((resolve) => { turnReleases.set(`${instance}:${binding.sessionId}`, resolve) })
          yield { type: "text-delta", delta: "real routed answer" }
          yield { type: "finish", sessionId: binding.sessionId }
        },
        async cancelTurn(binding: AgentExecutionBinding) {
          controls.push({ instance, action: "cancel" })
          if (options.cancelNeverSettles) return await new Promise<never>(() => {})
          const key = `${instance}:${binding.sessionId}`
          turnReleases.get(key)?.()
          turnReleases.delete(key)
          return { execution: "terminal" as const, cleanup: "verified_clear" as const }
        },
        async listPermissions() { return options.hold && instance === 1 ? [{ id: "pending", sessionID: "local", permission: "tool", patterns: [], metadata: {}, always: [] }] : [] },
        async respondPermission() { controls.push({ instance, action: "permission" }) },
        readHarnessCapabilities() { return { ...capabilities, goals: false, effortLevels: NO_HARNESS_EFFORT, instructionChannel: "none", harness: descriptor.connectionId } },
        dispose() { dead = true; disposed.push(instance); if (options.releaseOnDispose) release() },
      } satisfies AgentHarnessAdapter
    },
  }
  const snapshot = (name = "agent", revision = 1): RuntimeSnapshot => ({
    version: 4, mcp: {}, auth: {},
    connections: ["primary", "secondary"].map((connectionId) => ({
      connectionId, providerKey: "fixture", configRevision: revision, enabled: true, config: { name },
    })),
    defaultHarness: { kind: "connection", connectionId: "primary" },
  })
  let secretLease = "one"
  const rotateSecretLease = (next: string) => { secretLease = next }
  function open() {
    const host = createWorkspaceHost({ target, storeRoot, connectionProviders: [provider], resolveConnectionSecrets: () => ({ secrets: { token: secretLease }, secretLeaseGeneration: secretLease }), storeFactory: ({ storeRoot }) => {
      const store = new RuntimeStore(storeRoot)
      storeLifecycle.opened++
      const recover = store.recoverBusySessions.bind(store)
      const close = store.close.bind(store)
      store.recoverBusySessions = () => { storeLifecycle.recovered++; return recover() }
      store.close = () => { storeLifecycle.closed++; return close() }
      return store
    }, ...(options.native ? {
      harnesses: [{ match: () => true, create: ({ runner }) => provider.createAdapter({
        descriptor: { connectionId: runner.id, providerKey: "native-fixture", configRevision: 1, enabled: true, config: { name: runner.id } },
        resolved: { config: { name: runner.id } }, context: {} as never,
      }) }],
    } : {}) })
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
  return { ...open(), open, snapshot, rotateSecretLease, target, storeRoot, upstream, executions, disposed, resolvedDirectories, startedTurn, release, controls, configurations, storeLifecycle, creates: () => creates, adapters: () => adapters }
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
  for (const harness of ["claude", "codex", "connection"] as const) {
    test(`${harness} create returns the persisted title and workspace identity`, async () => {
      const f = await fixture({ native: true })
      await f.host.apply(f.snapshot())
      const title = "Named session café 日本語"
      const response = await f.request("/session", "POST", { id: "named", title }, harness === "connection" ? "" : `&nativeHarness=${harness}`)
      expect(response.status).toBe(201)
      const created = await response.json()
      expect(created).toMatchObject({ id: "named", title, directory: f.target.directory, workspaceId: f.target.workspaceId })
      expect(await (await f.request("/session/named")).json()).toMatchObject({ id: "named", title })
      await f.host.dispose()
      const reopened = f.open()
      expect(await (await reopened.request("/session/named")).json()).toMatchObject({ id: "named", title })
    })
  }

  test("lazy native admission applies an empty configuration once before creating the session", async () => {
    const f = await fixture({ native: true, configurable: true })
    const snapshot = f.snapshot()
    delete snapshot.defaultHarness
    await f.host.apply(snapshot)
    expect(f.adapters()).toBe(0)
    expect((await f.request("/session", "POST", { id: "first" }, "&nativeHarness=pi")).status).toBe(201)
    expect(f.configurations).toEqual([{ auth: {}, mcp: {}, launch: {}, harness: { id: "pi", access: "native" } }])
    expect((await f.request("/session", "POST", { id: "second" }, "&nativeHarness=pi")).status).toBe(201)
    expect(f.configurations).toHaveLength(1)
  })
  test("shutdown unblocks a pending create through adapter teardown before closing the store", async () => {
    const f = await fixture({ runtimeConfig: true, holdCreate: true, releaseOnDispose: true })
    await f.host.apply(f.snapshot())
    const create = f.request("/session", "POST", { id: "creating" })
    await f.startedTurn
    await f.host.dispose()
    expect((await create).status).toBe(201)
    expect(f.storeLifecycle).toEqual({ opened: 1, recovered: 1, closed: 1 })
    expect((await f.request("/session")).status).toBe(503)
  })

  test("source retirement after handoff leaves the target's active turn and adapter alive", async () => {
    const f = await fixture({ native: true, hold: true })
    await f.host.apply(f.snapshot())
    await f.request("/session", "POST", { id: "handoff" })
    const config = await f.request("/session/handoff/config", "PATCH", { harness: { id: "claude", access: "native" } })
    expect(config.status, await config.clone().text()).toBe(200)
    const prompt = f.request("/session/handoff/message", "POST", { parts: [{ type: "text", text: "target" }] })
    try {
      await f.startedTurn
      const removed = f.snapshot()
      removed.connections = removed.connections.filter((row) => row.connectionId !== "primary")
      removed.defaultHarness = { kind: "connection", connectionId: "secondary" }
      await f.host.apply(removed)
      expect(f.controls).toEqual([])
      // The target's read method detects disposal, even if HTTP would return
      // a 200 response containing a failed turn event.
      expect((await f.request("/session/handoff/config")).status).toBe(200)
      f.release()
      expect((await prompt).status).toBe(200)
      expect(f.executions.at(-1)?.connectionId).toBe("native:claude")
      const second = await f.request("/session/handoff/message", "POST", { parts: [{ type: "text", text: "still alive" }] })
      expect(second.status, await second.clone().text()).toBe(200)
      expect(f.executions).toHaveLength(2)
    } finally { f.release(); await prompt }
  })

  test("shutdown drains an admitted prompt before closing and never reopens its store", async () => {
    const f = await fixture({ runtimeConfig: true, hold: true, releaseOnDispose: true })
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

  test("native registry adapters borrow the host store without closing or recovering it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workspace-native-store-"))
    roots.push(directory)
    const store = new RuntimeStore(directory)
    cleanups.push(() => store.close())
    let closed = 0
    let recovered = 0
    const close = store.close.bind(store)
    store.close = () => { closed++; close() }
    store.recoverBusySessions = () => { recovered++ }
    for (const id of ["claude", "codex", "cursor", "pi"] as const) {
      const runner = { id, access: "native" as const }
      const entry = defaultWorkspaceHarnessRegistry().find((entry) => entry.match(runner))!
      const adapter = entry.create({ runner, options: { storeRoot: directory }, store })
      await adapter.dispose()
    }
    expect({ closed, recovered }).toEqual({ closed: 0, recovered: 0 })
    expect(store.listSessions(directory)).toEqual([])
  })

  test("retiring a used connection preserves the host store and other sessions", async () => {
    const f = await fixture({ runtimeConfig: true })
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
    const f = await fixture({ runtimeConfig: true })
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

  test("changing the default keeps an existing session adapter usable", async () => {
    const f = await fixture({ runtimeConfig: true, native: true })
    await f.host.apply({ ...f.snapshot(), defaultHarness: { kind: "native", harnessId: "claude" } })
    await f.request("/session", "POST", { id: "local" })
    const next = f.snapshot()
    next.defaultHarness = { kind: "native", harnessId: "codex" }
    await f.host.apply(next)
    const response = await f.request("/session/local/message", "POST", { parts: [{ type: "text", text: "old selection" }] })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(f.executions).toHaveLength(1)
    expect((await f.request("/session", "POST", { id: "new-default" })).status).toBe(201)
    expect((await f.request("/session/new-default/message", "POST", { parts: [{ type: "text", text: "new selection" }] })).status).toBe(200)
    expect(f.executions.map((binding) => binding.connectionId)).toEqual(["native:claude", "native:codex"])
  })

  test("removing a configured connection retires it before config fanout", async () => {
    const f = await fixture({ configurable: true })
    await f.host.apply(f.snapshot())
    await f.request("/session", "POST", { id: "secondary" }, "&connectionId=secondary")
    const removed = f.snapshot()
    removed.connections = removed.connections.filter((row) => row.connectionId !== "secondary")
    await f.host.apply(removed)
    expect(f.host.detail().state).toBe("ready")
    expect((await f.request("/session", "POST", { id: "healthy" })).status).toBe(201)
  })

  test("credential rotation keeps active permission and cancellation controls on the executing generation", async () => {
    const f = await fixture({ runtimeConfig: true, hold: true })
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
    const f = await fixture({ runtimeConfig: true, configurable: true, hold: true })
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
      expect(f.disposed.filter((instance) => instance === 1)).toHaveLength(1)
      expect(f.storeLifecycle.closed).toBe(0)
      expect((await f.request("/session", "POST", { id: "healthy" })).status).toBe(201)
    } finally {
      f.release()
      await prompt
    }
  })

  test("connection resolution follows a registered session worktree without retiring the root adapter", async () => {
    const f = await fixture({ runtimeConfig: true, scoped: true })
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

  test("empty inventory and status never select or construct a harness", async () => {
    const f = await fixture()
    expect(await (await f.request("/session")).json()).toEqual([])
    expect(await (await f.request("/session/status")).json()).toEqual({})
    expect((await f.request("/session/missing")).status).toBe(404)
    expect(f.adapters()).toBe(0)
  })

  test("a deleted session remains not found without a configured default harness", async () => {
    const f = await fixture()
    const snapshot = f.snapshot()
    delete snapshot.defaultHarness
    await f.host.apply(snapshot)
    expect((await f.request("/session", "POST", { id: "deleted" }, "&connectionId=primary")).status).toBe(201)
    expect((await f.request("/session/deleted", "DELETE")).status).toBe(200)
    expect((await f.request("/session/deleted")).status).toBe(404)
  })

  test("deleting an active session retires its host turn before removing its binding", async () => {
    const f = await fixture({ runtimeConfig: true, hold: true })
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
    const f = await fixture({ runtimeConfig: true })
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
    const f = await fixture()
    await f.host.apply(f.snapshot())
    expect((await f.request("/session", "POST", { id: "local" })).status).toBe(201)
    expect((await f.request("/session", "POST", { id: "local" })).status).toBe(201)
    expect(f.creates()).toBe(1)
    const switched = await f.request("/session", "POST", { id: "local" }, "&connectionId=secondary")
    expect(switched.status).toBe(409)
    expect(f.creates()).toBe(1)
    expect(await (await f.request("/session/local/config")).json()).toMatchObject({ harness: { id: "primary" } })
  })

  test("a rejected adapter config is not persisted", async () => {
    const f = await fixture()
    await f.host.apply(f.snapshot())
    await f.request("/session", "POST", { id: "local" })
    expect((await f.request("/session/local/config", "PATCH", { agent: "accepted" })).status).toBe(200)
    expect((await f.request("/session/local/config", "PATCH", { agent: "rejected" })).status).toBe(500)
    expect(await (await f.request("/session/local/config")).json()).toMatchObject({ agent: "accepted" })
  })

  test("inventory and upstream binding survive close/reopen without discovery", async () => {
    const f = await fixture({ runtimeConfig: true })
    await f.host.apply(f.snapshot())
    await f.request("/session", "POST", { id: "local" })
    await f.request("/session/local", "PATCH", { title: "Saved title" })
    await f.host.dispose()
    const before = f.adapters()
    const restored = f.open()
    const inventory = await (await restored.request("/session")).json()
    expect(inventory).toMatchObject([{ id: "local", title: "Saved title" }])
    expect(f.adapters()).toBe(before)
    await restored.host.apply(f.snapshot())
    expect((await restored.request("/session/local/message", "POST", {
      messageID: "restored-prompt", parts: [{ type: "text", text: "continue" }],
    })).status).toBe(200)
    expect(f.executions.at(-1)?.upstreamSessionId).toBe("upstream-local")
    expect(f.creates()).toBe(1)
  })

  test("failed connection validation preserves the previously applied config", async () => {
    const f = await fixture()
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
    const queue = await queuedPromptLeftBehind("workspace-queued-boot-")
    const prompts: string[] = []
    const host = createWorkspaceHost({
      target: queue.target,
      storeRoot: queue.storeRoot,
      harness: { kind: "native", harnessId: "claude" },
      harnesses: [{ match: () => true, create: () => queuedPromptAdapter(prompts) }],
    })
    cleanups.push(() => host.dispose())

    host.mount(new Hono(), { exposure: loopbackWorkspaceRuntimeExposure() })

    await until(() => prompts.length > 0)
    expect(prompts).toEqual(["then run the tests"])
    await host.dispose()
    const restarted = new RuntimeStore(queue.storeRoot)
    cleanups.push(() => restarted.close())
    expect(restarted.listQueuedPrompts()).toEqual([])
  })

  test("a runtime that learns its harness from a config snapshot re-issues the queue when it applies", async () => {
    const queue = await queuedPromptLeftBehind("workspace-queued-apply-")
    const prompts: string[] = []
    const host = createWorkspaceHost({
      target: queue.target,
      storeRoot: queue.storeRoot,
      harnesses: [{ match: () => true, create: () => queuedPromptAdapter(prompts) }],
    })
    cleanups.push(() => host.dispose())
    host.mount(new Hono(), { exposure: loopbackWorkspaceRuntimeExposure() })
    expect(prompts).toEqual([])

    await host.apply({
      version: 4, mcp: {}, auth: {}, connections: [],
      defaultHarness: { kind: "native", harnessId: "claude" },
    })

    await until(() => prompts.length > 0)
    expect(prompts).toEqual(["then run the tests"])
  })
  test("a cancellation that never settles leaves the freeze blocked, naming the turn, with writes still gated", async () => {
    const f = await fixture({ runtimeConfig: true, configurable: true, hold: true, cancelNeverSettles: true })
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
})

/** A store left behind by a process that died holding a queued prompt. */
async function queuedPromptLeftBehind(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  roots.push(directory)
  const storeRoot = join(directory, "state")
  const target = { workspaceId: "ws-queued", directory }
  const died = new RuntimeStore(storeRoot)
  died.bindSession({
    sessionId: "local", directory, workspaceId: target.workspaceId,
    connectionId: "native:claude", agentSessionId: "local", upstreamSessionId: "local",
  })
  died.updateSessionConfig("local", {
    harness: { id: "claude", access: "native" }, model: null, variant: null, agent: null,
  }, { directory })
  died.queuePrompt({
    sessionId: "local",
    messageId: "msg_queued",
    parts: [{ type: "text", text: "then run the tests" }],
    delivery: "queue",
  })
  died.close()
  return { target, storeRoot, directory }
}

/** A harness that only records the prompt text each turn was given. */
function queuedPromptAdapter(prompts: string[]): AgentHarnessAdapter {
  return {
    instructionChannel: "none",
    getSession: async (binding) => ({ id: binding.sessionId }),
    createSession: async (_directory, _title, id) => ({ id: id ?? "local" }),
    updateSession: async (binding) => ({ id: binding.sessionId }),
    getSessionConfig: async () => ({ harness: { id: "claude", access: "native" }, agent: null, variant: null }),
    updateSessionConfig: async (_binding, update) => ({
      harness: update.harness ?? { id: "claude", access: "native" }, agent: null, variant: null,
    }),
    deleteSession: async () => {},
    readHarnessCapabilities: () => ({ harness: "claude" }) as never,
    executeTurn: (_binding, input) => {
      prompts.push(input.parts.map((part) => ("text" in part ? part.text : "")).join(""))
      return (async function* () {})()
    },
    getMessages: async () => [],
    dispose: () => {},
  }
}

async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 400 && !condition(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  if (!condition()) throw new Error("condition never held")
}
