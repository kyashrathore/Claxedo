import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Hono } from "hono"
import type { AgentHarnessAdapter } from "@claxedo/agent-sdk-runtime/adapters"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"
import { withWorkspaceTarget } from "../target"
import { createWorkspaceHost } from "../workspace"
import { createRuntimeCredentialIssuer } from "./credential"
import { FIRST_PARTY_MCP_CONFIG_KEY, firstPartyMcpServerFor } from "./index"

/** Reads the provider the way agent-sdk-runtime's drivers do: the config record is the contract. */
function firstPartyMcpProvider(config: Record<string, unknown>) {
  const candidate = config[FIRST_PARTY_MCP_CONFIG_KEY] as { server?: unknown } | undefined
  return typeof candidate?.server === "function"
    ? { server: candidate.server as (sessionId: string) => { name: string; url: string; headers: Record<string, string> } }
    : undefined
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/**
 * A native-registry adapter that records every `applyConfig` payload the
 * engine hands it; everything else is the minimum the session-create route
 * touches.
 */
function recordingAdapter(configurations: Record<string, unknown>[]): AgentHarnessAdapter {
  const sessions = new Map<string, { id: string; directory: string; time: { created: number; updated: number } }>()
  type Binding = { sessionId: string }
  return {
    adapterCapabilities: ["runtime-config"] as const,
    setAuth() {},
    async applyConfig(config: Record<string, unknown>) { configurations.push(config) },
    async createSession(directory: string, _title?: string, id = "session") {
      sessions.set(id, { id, directory, time: { created: 1, updated: 1 } })
      return { id }
    },
    async listSessions() { return [...sessions.values()] },
    async getSession(binding: Binding) { return sessions.get(binding.sessionId) ?? null },
    async getMessages() { return [] },
    async updateSession(binding: Binding) { return sessions.get(binding.sessionId) ?? null },
    async deleteSession(binding: Binding) { sessions.delete(binding.sessionId) },
    async getSessionConfig() { return { harness: { id: "claude", access: "native" }, agent: null, variant: null } },
    async updateSessionConfig() { return { harness: { id: "claude", access: "native" }, agent: null, variant: null } },
    async *executeTurn() {},
    async listPermissions() { return [] },
    async respondPermission() {},
    readHarnessCapabilities() { return { goals: false, harness: "claude" } as never },
    dispose() {},
  } as unknown as AgentHarnessAdapter
}

function fixture(input: { firstParty: boolean; groups?: readonly string[] }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "first-party-injection-"))
  const storeRoot = path.join(directory, "store")
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }))
  const target = { workspaceId: "ws-1", directory }
  const issuer = createRuntimeCredentialIssuer({ runtimeId: "rt-1", workspaceId: "ws-1", userId: "user-1" })
  const launch = { baseUrl: "http://127.0.0.1:2593", issuer, enabledToolGroups: () => input.groups ?? ["sessions"] }
  const configurations: Record<string, unknown>[] = []
  const host = createWorkspaceHost({
    target,
    storeRoot,
    ...(input.firstParty ? { firstPartyMcpLaunch: launch } : {}),
    harnesses: [{ match: () => true, create: () => recordingAdapter(configurations) }],
  })
  cleanups.push(() => host.dispose())
  const app = new Hono()
  host.mount(app, { exposure: loopbackWorkspaceRuntimeExposure() })
  const createSession = (id: string) => withWorkspaceTarget(target, () => app.request(
    `http://runtime.test/session?directory=${encodeURIComponent(directory)}&nativeHarness=claude`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) },
  ))
  return { host, issuer, launch, configurations, createSession }
}

describe("first-party MCP injection through the workspace runtime", () => {
  test("every applyConfig carries a provider whose entry names the session, the loopback endpoint and the live bearer", async () => {
    const f = fixture({ firstParty: true })
    await f.host.apply({ version: 3, mcp: {}, auth: {}, connections: [], defaultHarness: { kind: "native", harnessId: "claude" } })
    expect((await f.createSession("session-a")).status).toBe(201)
    expect(f.configurations.length).toBeGreaterThan(0)

    for (const config of f.configurations) {
      const provider = firstPartyMcpProvider(config)
      expect(provider).toBeDefined()
      const entry = provider!.server("session-a")
      expect(entry).toEqual({
        name: "claxedo",
        url: "http://127.0.0.1:2593/api/claxedo/mcp?session=session-a",
        headers: { Authorization: f.issuer.header("session-a") },
      })
      expect(f.issuer.verify(entry.headers.Authorization.replace(/^Bearer /, ""))).toMatchObject({
        runtimeId: "rt-1", workspaceId: "ws-1", userId: "user-1", sessionId: "session-a",
      })
      expect(entry).toEqual(firstPartyMcpServerFor(f.launch, "session-a")!)
    }
    expect(JSON.stringify(f.configurations[0]?.mcp)).not.toContain("claxedo")
  })

  test("the provider reads the bearer at launch time, so a rotation reaches the next session without a re-apply", async () => {
    const f = fixture({ firstParty: true })
    await f.host.apply({ version: 3, mcp: {}, auth: {}, connections: [], defaultHarness: { kind: "native", harnessId: "claude" } })
    const provider = firstPartyMcpProvider(f.configurations.at(-1)!)!
    const before = provider.server("session-a").headers.Authorization
    f.issuer.rotate()
    const after = provider.server("session-a").headers.Authorization
    expect(after).not.toBe(before)
    expect(f.issuer.verify(before.replace(/^Bearer /, ""))).toBeUndefined()
    expect(f.issuer.verify(after.replace(/^Bearer /, ""))).toBeDefined()
  })

  test("a runtime composed without the launch option injects nothing and exposes no issuer", async () => {
    const f = fixture({ firstParty: false })
    await f.host.apply({ version: 3, mcp: {}, auth: {}, connections: [], defaultHarness: { kind: "native", harnessId: "claude" } })
    expect((await f.createSession("session-a")).status).toBe(201)
    expect(f.configurations.every((config) => !(FIRST_PARTY_MCP_CONFIG_KEY in config))).toBe(true)
    expect(f.host.runtimeCredentialIssuer()).toBeUndefined()
  })

  test("a project with every group off gets no entry, so no session is handed an endpoint with no tools", async () => {
    const f = fixture({ firstParty: true, groups: [] })
    await f.host.apply({ version: 3, mcp: {}, auth: {}, connections: [], defaultHarness: { kind: "native", harnessId: "claude" } })
    expect((await f.createSession("session-a")).status).toBe(201)
    expect(f.configurations.length).toBeGreaterThan(0)
    expect(f.configurations.every((config) => !(FIRST_PARTY_MCP_CONFIG_KEY in config))).toBe(true)
    expect(f.host.firstPartyMcpServer("session-a")).toBeUndefined()
  })

  test("the host exposes the issuer it injects with, for the endpoint mount to verify callers", () => {
    const f = fixture({ firstParty: true })
    expect(f.host.runtimeCredentialIssuer()).toBe(f.issuer)
    expect(f.host.runtimeCredentialIssuer()?.verify(f.issuer.current())?.workspaceId).toBe("ws-1")
  })
})
