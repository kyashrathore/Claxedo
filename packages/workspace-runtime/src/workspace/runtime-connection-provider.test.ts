import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HarnessConnectionCapabilities } from "@claxedo/agent-runtime-contract"
import { Hono } from "hono"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"
import { FakeTransport, fakeConnectionProvider } from "@claxedo/session-core/testing"
import { withWorkspaceTarget } from "../target"
import { loopbackMachineLoginPolicy } from "../testing"
import { createWorkspaceHost } from "./runtime"
import type { WorkspaceHostOptions } from "./host-options"
import { WorkspaceHarnessUnavailableError } from "@claxedo/session-core"

const roots: string[] = []
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

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

async function workspaceRoot(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function mountedHost(root: string, workspaceId: string, options: Omit<WorkspaceHostOptions, "placement" | "target" | "storeRoot" | "harnessStateRoot" | "sessionIdWorkspace">) {
  const target = { workspaceId, directory: root }
  const host = createWorkspaceHost({
  sessionIdWorkspace: () => undefined, placement: loopbackMachineLoginPolicy(), target, storeRoot: join(root, "store"), harnessStateRoot: join(root, "harness"), ...options })
  const app = new Hono()
  host.mount(app, { exposure: loopbackWorkspaceRuntimeExposure() })
  const create = (id: string, query = "&connectionId=fixture-primary") => withWorkspaceTarget(target, () => app.request(
    `http://runtime.test/session?directory=${encodeURIComponent(root)}${query}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) },
  ))
  return { host, create }
}

const fixtureConnection = (secretRefs?: Record<string, string>) => ({
  connectionId: "fixture-primary", providerKey: "fixture", configRevision: 1, enabled: true, config: { label: "Fixture" },
  ...(secretRefs ? { secretRefs } : {}),
})

describe("WorkspaceRuntime generic connection selection", () => {
  test("concurrent first resolutions of one connection compose one transport and dispose it once", async () => {
    const root = await workspaceRoot("workspace-runtime-concurrent-")
    let created = 0
    let disposed = 0
    const provider = fakeConnectionProvider({
      providerKey: "fixture",
      capabilities,
      transport: () => {
        created++
        return new FakeTransport({ onDispose: () => { disposed++ } })
      },
    })
    const { host, create } = mountedHost(root, "ws-concurrent", { connectionProviders: [provider] })
    try {
      await host.apply({ version: 4, commands: [], mcp: {}, auth: { machineOwnerUserId: "local", accounts: { local: {} } }, connections: [fixtureConnection()], defaultHarness: { kind: "connection", connectionId: "fixture-primary" } })
      const responses = await Promise.all([create("one"), create("two")])
      expect(responses.map((response) => response.status)).toEqual([201, 201])
      expect(created).toBe(1)
      expect(disposed).toBe(0)
    } finally { await host.dispose() }
    expect(disposed).toBe(1)
  })

  test("resolves a host-owned secret lease and reports only the public selection", async () => {
    const root = await workspaceRoot("workspace-runtime-provider-")
    let resolvedSecrets: Readonly<Record<string, string>> | undefined
    let resolutions = 0
    const provider = fakeConnectionProvider<{ label: string }>({
      providerKey: "fixture",
      validateConfig(input) {
        if (!input || typeof input !== "object" || typeof (input as { label?: unknown }).label !== "string") throw new Error("label required")
        return { label: (input as { label: string }).label }
      },
      label: (config) => config.label,
      capabilities,
      resolve({ descriptor, secrets }) {
        resolutions++
        resolvedSecrets = secrets
        return descriptor.config
      },
      transport: () => new FakeTransport({
        health: {
          connection: () => ({ state: "ready", processes: [{ generation: "opaque-generation", role: "execution", state: "ready", observedAt: 1 }] }),
          runtime: () => ({ status: "ok" }),
        },
      }),
    })
    const { host, create } = mountedHost(root, "ws-1", {
      connectionProviders: [provider],
      resolveConnectionSecrets: () => ({ secrets: { token: "runtime-only" }, secretLeaseGeneration: "lease-1" }),
    })
    await host.apply({
      version: 4, commands: [],
      mcp: {},
      connections: [fixtureConnection({ token: "credentials/fixture" })],
      defaultHarness: { kind: "connection", connectionId: "fixture-primary" },
      auth: { machineOwnerUserId: "local", accounts: { local: {} } },
    })
    expect(host.detail().harness).toEqual({ kind: "connection", connectionId: "fixture-primary" })
    expect(host.detail().connectionState).toEqual({ connectionId: "fixture-primary", state: "configured", processes: [] })
    expect(resolutions).toBe(0)

    expect((await create("local-one")).status).toBe(201)
    expect(resolvedSecrets).toEqual({ token: "runtime-only" })
    expect(host.detail().connectionState).toEqual({ connectionId: "fixture-primary", state: "ready", processes: [{ generation: "opaque-generation", role: "execution", state: "ready", observedAt: 1 }] })
    expect(host.readConnectionState()).toEqual(host.detail().connectionState)
    expect(await host.readHarnessHealth({ sessionId: "unknown" })).toEqual({ status: "ok" })
    expect(host.readConnectionState({ sessionId: "unknown" })).toBeUndefined()
    expect(resolutions).toBe(1)
    expect(JSON.stringify(host.detail())).not.toContain("runtime-only")
    expect(JSON.stringify(host.detail())).not.toContain("lease-1")
    await host.dispose()
  })

  test("fails closed when a session selects a connection whose secret references no host resolves", async () => {
    const root = await workspaceRoot("workspace-runtime-provider-")
    const provider = fakeConnectionProvider({ providerKey: "fixture", capabilities, transport: () => new FakeTransport() })
    const { host, create } = mountedHost(root, "ws-1", { connectionProviders: [provider] })
    await host.apply({
      version: 4, commands: [],
      mcp: {},
      connections: [fixtureConnection({ token: "credentials/fixture" })],
      defaultHarness: { kind: "connection", connectionId: "fixture-primary" },
      auth: { machineOwnerUserId: "local", accounts: { local: {} } },
    })
    const refused = await create("unresolved")
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ error: { code: new WorkspaceHarnessUnavailableError({ id: "fixture-primary", access: "connection" }).code } })
    await host.dispose()
  })

  test("rotates connection transports when a VM secret lease changes", async () => {
    const root = await workspaceRoot("workspace-runtime-provider-")
    const createdWith: string[] = []
    const disposed: string[] = []
    const provider = fakeConnectionProvider<{ label: string }, { token: string }>({
      providerKey: "fixture",
      validateConfig: (input) => input as { label: string },
      label: (config) => config.label,
      capabilities,
      resolve: ({ secrets }) => ({ token: secrets.token }),
      transport: ({ resolved }) => {
        const token = resolved.config.token
        const generation = crypto.randomUUID()
        return new FakeTransport({
          capabilities: { instructionChannel: "none" },
          onStart: () => { createdWith.push(token) },
          onDispose: () => { disposed.push(token) },
          health: {
            connection: () => ({ state: "ready", processes: [{ generation, role: "execution", state: "ready", observedAt: 1 }] }),
            runtime: () => ({ status: "ok" }),
          },
        })
      },
    })
    let lease = "lease-one"
    const { host, create } = mountedHost(root, "ws-1", {
      connectionProviders: [provider],
      resolveConnectionSecrets: () => ({ secrets: { token: lease }, secretLeaseGeneration: lease }),
    })
    await host.apply({
      version: 4, commands: [],
      mcp: {},
      connections: [fixtureConnection({ token: "credential:fixture" })],
      defaultHarness: { kind: "connection", connectionId: "fixture-primary" },
      auth: { machineOwnerUserId: "local", accounts: { local: {} } },
    })

    const first = await create("local-one")
    expect(first.status, await first.clone().text()).toBe(201)
    const beforeRotation = host.readConnectionState({ sessionId: "local-one", directory: root })
    expect(beforeRotation?.state).toBe("ready")
    expect(beforeRotation?.connectionId).toBe("fixture-primary")

    lease = "lease-two"
    const second = await create("local-two")
    expect(second.status, await second.clone().text()).toBe(201)
    expect(createdWith).toEqual(["lease-one", "lease-two"])
    for (let attempt = 0; attempt < 100 && !disposed.includes("lease-one"); attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(disposed).toEqual(["lease-one"])
    const afterRotation = host.readConnectionState({ sessionId: "local-one", directory: root })
    expect(afterRotation?.state).toBe("ready")
    expect(afterRotation?.processes[0]?.generation).not.toBe(beforeRotation?.processes[0]?.generation)
    await host.dispose()
  })

  test("a connection default handed at creation applies its first snapshot and still serves a native session", async () => {
    const root = await workspaceRoot("workspace-runtime-creation-default-")
    const provider = fakeConnectionProvider({ providerKey: "fixture", capabilities, transport: () => new FakeTransport() })
    const { host, create } = mountedHost(root, "ws-creation-default", {
      connectionProviders: [provider],
      harness: { kind: "connection", connectionId: "fixture-primary" },
    })
    try {
      await host.apply({
        version: 4, commands: [],
        mcp: {},
        auth: { machineOwnerUserId: "local", accounts: { local: {} } },
        connections: [fixtureConnection()],
        defaultHarness: { kind: "connection", connectionId: "fixture-primary" },
      })
      expect(host.detail()).toMatchObject({
        state: "ready",
        harness: { kind: "connection", connectionId: "fixture-primary" },
        configApply: { state: "applied" },
      })
      const created = await create("native-one", "&nativeHarness=pi")
      expect(created.status, await created.clone().text()).toBe(201)
      expect(await created.json()).toMatchObject({ id: "native-one" })
    } finally { await host.dispose() }
  })

  test("leaves default selection unresolved when policy omits it", async () => {
    const root = await workspaceRoot("workspace-runtime-unselected-")
    const { host } = mountedHost(root, "ws-unselected", {})
    await host.apply({ version: 4, commands: [], mcp: {}, connections: [], auth: { machineOwnerUserId: "local", accounts: { local: {} } } })
    expect(host.detail().harness).toBeUndefined()
    await host.dispose()
  })
})
