import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentExecutionBinding } from "@claxedo/agent-runtime-contract"
import type { ConnectionProvider, HarnessConnectionCapabilities } from "@claxedo/agent-sdk-runtime"
import type { AgentHarnessAdapter } from "@claxedo/agent-sdk-runtime/adapters"
import { Hono } from "hono"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"
import { withWorkspaceTarget } from "../target"
import { createWorkspaceHost, WorkspaceHarnessUnavailableError } from "./runtime"

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
    async createSession() { return { id: "session-1" } },
    async getSession(binding: AgentExecutionBinding) { return { id: binding.sessionId } },
    async updateSession(binding: AgentExecutionBinding) { return { id: binding.sessionId } },
    async deleteSession() {},
    async getSessionConfig() { return { harness: { id: "fixture-primary", access: "connection" }, variant: null, agent: null } },
    async updateSessionConfig(_binding, update) {
      return { harness: update.harness ?? { id: "fixture-primary", access: "connection" }, variant: null, agent: null }
    },
    async getMessages() { return [] },
    readHarnessCapabilities() { return { ...capabilities, harness: "fixture-primary" } },
    dispose() {},
  }
}

describe("WorkspaceRuntime generic connection selection", () => {
  test("resolves a host-owned secret lease and reports only the public selection", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-runtime-provider-"))
    roots.push(root)
    let resolvedSecrets: Readonly<Record<string, string>> | undefined
    const provider: ConnectionProvider<{ label: string }> = {
      providerKey: "fixture",
      validateConfig(input) {
        if (!input || typeof input !== "object" || typeof (input as { label?: unknown }).label !== "string") throw new Error("label required")
        return { label: (input as { label: string }).label }
      },
      project(config) { return { label: config.label, readiness: "ready", capabilities } },
      resolve({ descriptor, secrets }) {
        resolvedSecrets = secrets
        return { config: descriptor.config }
      },
      createAdapter: adapter,
    }
    const host = createWorkspaceHost({
      target: { workspaceId: "ws-1", directory: root },
      storeRoot: join(root, "store"),
      connectionProviders: [provider],
      resolveConnectionSecrets: () => ({ secrets: { token: "runtime-only" }, secretLeaseGeneration: "lease-1" }),
    })
    await host.apply({
      version: 3,
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
    host.dispose()
  })

  test("fails closed when a selected connection has unresolved secret references", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-runtime-provider-"))
    roots.push(root)
    const host = createWorkspaceHost({ target: { workspaceId: "ws-1", directory: root }, storeRoot: join(root, "store") })
    await expect(host.apply({
      version: 3,
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
    host.dispose()
  })

  test("materializes VM connection secrets from the consent-filtered runtime snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-runtime-provider-"))
    roots.push(root)
    let resolvedSecrets: Readonly<Record<string, string>> | undefined
    const provider: ConnectionProvider<{ label: string }> = {
      providerKey: "fixture",
      validateConfig(input) { return input as { label: string } },
      project(config) { return { label: config.label, readiness: "ready", capabilities } },
      resolve({ descriptor, secrets }) {
        resolvedSecrets = secrets
        return { config: descriptor.config }
      },
      createAdapter: adapter,
    }
    const host = createWorkspaceHost({
      target: { workspaceId: "ws-1", directory: root },
      storeRoot: join(root, "store"),
      connectionProviders: [provider],
    })
    await host.apply({
      version: 3,
      mcp: {},
      connections: [{
        connectionId: "fixture-primary",
        providerKey: "fixture",
        configRevision: 1,
        enabled: true,
        config: { label: "Fixture" },
        secretRefs: { token: "credential:external-agent" },
      }],
      defaultHarness: { kind: "connection", connectionId: "fixture-primary" },
      auth: { "credential:external-agent": "vm-runtime-secret" },
    })
    expect(resolvedSecrets).toEqual({ token: "vm-runtime-secret" })
    expect(JSON.stringify(host.detail())).not.toContain("vm-runtime-secret")
    host.dispose()
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
      resolve({ secrets }) { return { config: { token: secrets.token! } } },
      createAdapter({ resolved }) {
        const token = resolved.config.token
        return {
          sessionConfigOwner: "runtime" as const,
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
          readHarnessCapabilities() { return { ...capabilities, harness: "fixture-primary" } },
          dispose() { disposed.push(token) },
        }
      },
    }
    const host = createWorkspaceHost({
      target: { workspaceId: "ws-1", directory: root },
      storeRoot: join(root, "store"),
      connectionProviders: [provider],
    })
    const snapshot = (token: string) => ({
      version: 3 as const,
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
      auth: { "credential:fixture": token },
    })
    const app = new Hono()
    host.mount(app, { exposure: loopbackWorkspaceRuntimeExposure() })

    await host.apply(snapshot("lease-one"))
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

    await host.apply(snapshot("lease-two"))
    const second = await request("local-two")
    expect(second.status, await second.clone().text()).toBe(201)
    expect(createdWith).toEqual(["lease-one", "lease-two"])
    expect(disposed).toContain("lease-one")
    host.dispose()
  })

  test("leaves default selection unresolved when policy omits it", async () => {
    const host = createWorkspaceHost()
    await host.apply({ version: 3, mcp: {}, connections: [], auth: {} })
    expect(host.detail().harness).toBeUndefined()
    host.dispose()
  })
})
