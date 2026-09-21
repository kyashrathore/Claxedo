import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentExecutionBinding } from "@claxedo/agent-runtime-contract"
import { NO_HARNESS_EFFORT } from "@claxedo/agent-runtime-contract"
import type { ConnectionProvider, HarnessConnectionCapabilities } from "@claxedo/agent-sdk-runtime"
import type { AgentHarnessAdapter } from "@claxedo/agent-sdk-runtime/adapters"
import { Hono } from "hono"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"
import { withWorkspaceTarget } from "../target"
import { createWorkspaceHost } from "./runtime"
import { WorkspaceHarnessUnavailableError } from "../harness-unavailable-error"

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

const capabilities: HarnessConnectionCapabilities = {
  abort: false,
  reconnect: false,
  replay: true,
  permissions: false,
  questions: false,
  todos: false,
  commands: false,
  fork: false,
  revert: false,
  unrevert: false,
  configOptions: false,
  subagents: false,
}

function adapter(): AgentHarnessAdapter {
  return {
    instructionChannel: "none",
    async *executeTurn() {},
    async createSession() { return { id: "session-1" } },
    async getSession(binding: AgentExecutionBinding) { return { id: binding.sessionId } },
    async updateSession(binding: AgentExecutionBinding) { return { id: binding.sessionId } },
    async deleteSession() {},
    async getSessionConfig() { return { harness: { id: "fixture-primary", access: "connection" }, variant: null, agent: null } },
    async updateSessionConfig(_binding, update) {
      return { harness: update.harness ?? { id: "fixture-primary", access: "connection" }, variant: null, agent: null }
    },
    async getMessages() { return [] },
    readHarnessCapabilities() { return { ...capabilities, goals: false, effortLevels: NO_HARNESS_EFFORT, instructionChannel: "none", harness: "fixture-primary" } },
    dispose() {},
  }
}

function nativeAdapter(harnessId: string): AgentHarnessAdapter {
  return {
    ...adapter(),
    async createSession(directory: string, title?: string, id?: string) {
      return { id: id ?? "native-session", ...(title ? { title } : {}), directory, time: { created: 10, updated: 10 } }
    },
    async getSessionConfig() { return { harness: { id: harnessId, access: "native" as const }, variant: null, agent: null } },
    async updateSessionConfig(_binding: AgentExecutionBinding, update: { harness?: { id: string; access: "native" | "connection" } }) {
      return { harness: update.harness ?? { id: harnessId, access: "native" as const }, variant: null, agent: null }
    },
    readHarnessCapabilities() {
      return { ...capabilities, goals: false, effortLevels: NO_HARNESS_EFFORT, instructionChannel: "none" as const, harness: harnessId }
    },
  }
}

describe("WorkspaceRuntime generic connection selection", () => {
  test("concurrent duplicate resolutions await rejected loser teardown without returning the cached adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-runtime-loser-"))
    roots.push(root)
    let created = 0
    let canonicalDisposed = 0
    const provider: ConnectionProvider<Record<string, never>> = {
      providerKey: "fixture",
      validateConfig: () => ({}),
      project: () => ({ label: "Fixture", readiness: "ready", capabilities }),
      resolve: () => ({ config: {} }),
      createAdapter() {
        const instance = ++created
        return {
          ...adapter(),
          dispose() {
            if (instance === 1) {
              canonicalDisposed++
              return Promise.resolve()
            }
            const rejected = Promise.reject(new Error("Loser teardown failed"))
            void rejected.catch(() => {})
            return rejected
          },
        }
      },
    }
    const target = { workspaceId: "ws-loser", directory: root }
    const host = createWorkspaceHost({ target, storeRoot: join(root, "store"), connectionProviders: [provider] })
    const app = new Hono()
    host.mount(app, { exposure: loopbackWorkspaceRuntimeExposure() })
    try {
      await host.apply({ version: 4, mcp: {}, auth: {}, connections: [{
        connectionId: "fixture-primary", providerKey: "fixture", configRevision: 1, enabled: true, config: {},
      }], defaultHarness: { kind: "connection", connectionId: "fixture-primary" } })
      const request = (id: string) => withWorkspaceTarget(target, () => app.request(
        `http://runtime.test/session?directory=${encodeURIComponent(root)}&connectionId=fixture-primary`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) },
      ))
      const responses = await Promise.all([request("one"), request("two")])
      expect(responses.map((response) => response.status)).toEqual([500, 500])
      expect(created).toBe(3)
      expect(canonicalDisposed).toBe(0)
    } finally { await host.dispose() }
    expect(canonicalDisposed).toBe(1)
  })

  test("resolves a host-owned secret lease and reports only the public selection", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-runtime-provider-"))
    roots.push(root)
    let resolvedSecrets: Readonly<Record<string, string>> | undefined
    let resolutions = 0
    const provider: ConnectionProvider<{ label: string }> = {
      providerKey: "fixture",
      validateConfig(input) {
        if (!input || typeof input !== "object" || typeof (input as { label?: unknown }).label !== "string") throw new Error("label required")
        return { label: (input as { label: string }).label }
      },
      project(config) { return { label: config.label, readiness: "ready", capabilities } },
      resolve({ descriptor, secrets }) {
        resolutions++
        resolvedSecrets = secrets
        return { config: descriptor.config }
      },
      createAdapter: () => ({ ...adapter(), readConnectionState: () => ({ state: "ready", processes: [{ generation: "opaque-generation", role: "execution", state: "ready", observedAt: 1 }] }) }),
    }
    const host = createWorkspaceHost({
      target: { workspaceId: "ws-1", directory: root },
      storeRoot: join(root, "store"),
      connectionProviders: [provider],
      resolveConnectionSecrets: () => ({ secrets: { token: "runtime-only" }, secretLeaseGeneration: "lease-1" }),
    })
    await host.apply({
      version: 4,
      mcp: {},
      connections: [{
        connectionId: "fixture-primary",
        providerKey: "fixture",
        configRevision: 1,
        enabled: true,
        config: { label: "Fixture" },
        secretRefs: { token: "credentials/fixture" },
      }],
      defaultHarness: { kind: "connection", connectionId: "fixture-primary" },
      auth: {},
    })
    expect(resolvedSecrets).toEqual({ token: "runtime-only" })
    expect(host.detail().harness).toEqual({ kind: "connection", connectionId: "fixture-primary" })
    expect(host.detail().connectionState).toEqual({ connectionId: "fixture-primary", state: "ready", processes: [{ generation: "opaque-generation", role: "execution", state: "ready", observedAt: 1 }] })
    expect(host.readConnectionState()).toEqual(host.detail().connectionState)
    expect(await host.readHarnessHealth({ sessionId: "unknown" })).toEqual({ status: "ok" })
    expect(host.readConnectionState({ sessionId: "unknown" })).toBeUndefined()
    expect(resolutions).toBe(1)
    expect(JSON.stringify(host.detail())).not.toContain("runtime-only")
    expect(JSON.stringify(host.detail())).not.toContain("lease-1")
    await host.dispose()
  })

  test("fails closed when a selected connection has unresolved secret references", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-runtime-provider-"))
    roots.push(root)
    const host = createWorkspaceHost({ target: { workspaceId: "ws-1", directory: root }, storeRoot: join(root, "store") })
    await expect(host.apply({
      version: 4,
      mcp: {},
      connections: [{
        connectionId: "acp-primary",
        providerKey: "acp",
        configRevision: 1,
        enabled: true,
        config: { label: "ACP", connection: { kind: "process", command: "/bin/agent" } },
        secretRefs: { token: "credentials/acp" },
      }],
      defaultHarness: { kind: "connection", connectionId: "acp-primary" },
      auth: {},
    })).rejects.toBeInstanceOf(WorkspaceHarnessUnavailableError)
    await host.dispose()
  })

  test("rotates connection adapters when a VM secret lease changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-runtime-provider-"))
    roots.push(root)
    const createdWith: string[] = []
    const disposed: string[] = []
    const provider: ConnectionProvider<{ label: string }, { token: string }> = {
      providerKey: "fixture",
      validateConfig(input) { return input as { label: string } },
      project(config) { return { label: config.label, readiness: "ready", capabilities } },
      resolve({ secrets }) { return { config: { token: secrets.token } } },
      createAdapter({ resolved }) {
        const token = resolved.config.token
        const generation = crypto.randomUUID()
        return {
          sessionConfigOwner: "runtime" as const,
          instructionChannel: "none" as const,
          async *executeTurn() {},
          async createSession(_directory, _title, id) {
            createdWith.push(token)
            return { id: id ?? `session-${createdWith.length}` }
          },
          async getSession(binding) { return { id: binding.sessionId } },
          async updateSession(binding) { return { id: binding.sessionId } },
          async deleteSession() {},
          async getSessionConfig() { throw new Error("runtime-owned config must not reach the adapter") },
          async updateSessionConfig() { throw new Error("runtime-owned config must not reach the adapter") },
          async getMessages() { return [] },
          readConnectionState() { return { state: "ready", processes: [{ generation, role: "execution", state: "ready", observedAt: 1 }] } },
          readHarnessCapabilities() { return { ...capabilities, goals: false, effortLevels: NO_HARNESS_EFFORT, instructionChannel: "none", harness: "fixture-primary" } },
          dispose() { disposed.push(token) },
        }
      },
    }
    let lease = "lease-one"
    const host = createWorkspaceHost({
      target: { workspaceId: "ws-1", directory: root },
      storeRoot: join(root, "store"),
      connectionProviders: [provider],
      resolveConnectionSecrets: () => ({ secrets: { token: lease }, secretLeaseGeneration: lease }),
    })
    const snapshot = () => ({
      version: 4 as const,
      mcp: {},
      connections: [{
        connectionId: "fixture-primary",
        providerKey: "fixture",
        configRevision: 1,
        enabled: true,
        config: { label: "Fixture" },
        secretRefs: { token: "credential:fixture" },
      }],
      defaultHarness: { kind: "connection" as const, connectionId: "fixture-primary" },
      auth: {},
    })
    const app = new Hono()
    host.mount(app, { exposure: loopbackWorkspaceRuntimeExposure() })

    await host.apply(snapshot())
    const request = (id: string) => withWorkspaceTarget(
      { workspaceId: "ws-1", directory: root },
      () => app.request(`http://runtime.test/session?directory=${encodeURIComponent(root)}&connectionId=fixture-primary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      }),
    )
    const first = await request("local-one")
    expect(first.status, await first.clone().text()).toBe(201)
    const beforeRotation = host.readConnectionState({ sessionId: "local-one", directory: root })
    expect(beforeRotation?.state).toBe("ready")
    expect(beforeRotation?.connectionId).toBe("fixture-primary")

    lease = "lease-two"
    const second = await request("local-two")
    expect(second.status, await second.clone().text()).toBe(201)
    expect(createdWith).toEqual(["lease-one", "lease-two"])
    expect(disposed).toContain("lease-one")
    const afterRotation = host.readConnectionState({ sessionId: "local-one", directory: root })
    expect(afterRotation?.state).toBe("ready")
    expect(afterRotation?.processes[0]?.generation).not.toBe(beforeRotation?.processes[0]?.generation)
    expect(host.readConnectionState({ sessionId: "local-one", directory: "/other" })?.state).toBe("configured")
    await host.dispose()
  })

  test("a connection default handed at creation applies its first snapshot and still serves a native session", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-runtime-creation-default-"))
    roots.push(root)
    const provider: ConnectionProvider<Record<string, never>> = {
      providerKey: "fixture",
      validateConfig: () => ({}),
      project: () => ({ label: "Fixture", readiness: "ready", capabilities }),
      resolve: () => ({ config: {} }),
      createAdapter: adapter,
    }
    const target = { workspaceId: "ws-creation-default", directory: root }
    const host = createWorkspaceHost({
      target,
      storeRoot: join(root, "store"),
      connectionProviders: [provider],
      harness: { kind: "connection", connectionId: "fixture-primary" },
      harnesses: [{ match: (runner) => runner.access === "native", create: ({ runner }) => nativeAdapter(runner.id) }],
    })
    const app = new Hono()
    host.mount(app, { exposure: loopbackWorkspaceRuntimeExposure() })
    try {
      await host.apply({
        version: 4,
        mcp: {},
        auth: {},
        connections: [{ connectionId: "fixture-primary", providerKey: "fixture", configRevision: 1, enabled: true, config: {} }],
        defaultHarness: { kind: "connection", connectionId: "fixture-primary" },
      })
      expect(host.detail()).toMatchObject({
        state: "ready",
        harness: { kind: "connection", connectionId: "fixture-primary" },
        configApply: { state: "applied" },
      })
      const created = await withWorkspaceTarget(target, () => app.request(
        `http://runtime.test/session?directory=${encodeURIComponent(root)}&nativeHarness=codex`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "native-one" }) },
      ))
      expect(created.status, await created.clone().text()).toBe(201)
      expect(await created.json()).toMatchObject({ id: "native-one" })
    } finally { await host.dispose() }
  })

  test("leaves default selection unresolved when policy omits it", async () => {
    const host = createWorkspaceHost()
    await host.apply({ version: 4, mcp: {}, connections: [], auth: {} })
    expect(host.detail().harness).toBeUndefined()
    await host.dispose()
  })
})
