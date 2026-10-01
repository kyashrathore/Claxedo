import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { HarnessServices, McpServerSpec, StartInput } from "@claxedo/harness/contract"
import { Hono } from "hono"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"
import { FakeTransport, fakeConnectionProvider } from "@claxedo/session-core/testing"
import { withWorkspaceTarget } from "../target"
import { loopbackMachineLoginPolicy } from "../testing"
import { createWorkspaceHost } from "../workspace"
import { createRuntimeCredentialIssuer } from "./credential"
import { firstPartyMcpServerFor } from "./index"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/**
 * A workspace host over one connection whose transport records, at each
 * start, the first-party entry the host's services hand that session: the
 * one source every transport reads it from.
 */
function fixture(input: { firstParty: boolean; groups?: readonly string[] }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "first-party-injection-"))
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }))
  const target = { workspaceId: "ws-1", directory }
  const issuer = createRuntimeCredentialIssuer({ runtimeId: "rt-1", workspaceId: "ws-1", userId: "user-1" })
  const launch = { baseUrl: "http://127.0.0.1:2593", issuer, enabledToolGroups: () => input.groups ?? ["sessions"] }
  const entries: Array<{ sessionId: string; entry: McpServerSpec | undefined }> = []
  let services: HarnessServices | undefined
  const provider = fakeConnectionProvider({
    providerKey: "fixture",
    transport: ({ services: composed }) => {
      services = composed
      return new FakeTransport({
        onStart: (start: StartInput) => { entries.push({ sessionId: start.sessionId, entry: composed.firstPartyMcp(start.sessionId, start.locality) }) },
      })
    },
  })
  const host = createWorkspaceHost({
    sessionIdWorkspace: () => undefined,
    placement: loopbackMachineLoginPolicy(),
    target,
    storeRoot: path.join(directory, "store"),
    harnessStateRoot: path.join(directory, "harness"),
    connectionProviders: [provider],
    ...(input.firstParty ? { firstPartyMcpLaunch: launch } : {}),
  })
  cleanups.push(() => host.dispose())
  const app = new Hono()
  host.mount(app, { exposure: loopbackWorkspaceRuntimeExposure() })
  const apply = () => host.apply({
    version: 4, commands: [], mcp: {}, auth: { machineOwnerUserId: "local", accounts: { local: {} } },
    connections: [{ connectionId: "fixture", providerKey: "fixture", configRevision: 1, enabled: true, config: {} }],
    defaultHarness: { kind: "connection", connectionId: "fixture" },
  })
  const createSession = (id: string) => withWorkspaceTarget(target, () => app.request(
    `http://runtime.test/session?directory=${encodeURIComponent(directory)}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) },
  ))
  return { host, issuer, launch, entries, services: () => services, apply, createSession }
}

describe("first-party MCP injection through the workspace runtime", () => {
  test("every local start receives an entry naming the session, the loopback endpoint and the live bearer", async () => {
    const f = fixture({ firstParty: true })
    await f.apply()
    expect((await f.createSession("session-a")).status).toBe(201)

    expect(f.entries).toHaveLength(1)
    const entry = f.entries[0].entry
    expect(entry).toEqual({
      kind: "http",
      name: "claxedo",
      url: "http://127.0.0.1:2593/api/claxedo/mcp?session=session-a",
      headers: { Authorization: f.issuer.header("session-a") },
    })
    expect(f.issuer.verify(f.issuer.header("session-a").replace(/^Bearer /, ""))).toMatchObject({
      runtimeId: "rt-1", workspaceId: "ws-1", userId: "user-1", sessionId: "session-a",
    })
    expect(entry).toEqual({ kind: "http", ...firstPartyMcpServerFor(f.launch, "session-a")! })
    expect(f.services()?.firstPartyMcp("session-a", "remote")).toBeUndefined()
  })

  test("the entry reads the bearer at launch time, so a rotation reaches the next session without a re-apply", async () => {
    const f = fixture({ firstParty: true })
    await f.apply()
    expect((await f.createSession("session-a")).status).toBe(201)
    const before = f.entries[0].entry as { headers: Record<string, string> }
    f.issuer.rotate()
    expect((await f.createSession("session-b")).status).toBe(201)
    const after = f.entries[1].entry as { headers: Record<string, string> }
    expect(after.headers.Authorization).not.toBe(before.headers.Authorization)
    expect(f.issuer.verify(before.headers.Authorization.replace(/^Bearer /, ""))).toBeUndefined()
    expect(f.issuer.verify(after.headers.Authorization.replace(/^Bearer /, ""))).toBeDefined()
  })

  test("a runtime composed without the launch option injects nothing and exposes no issuer", async () => {
    const f = fixture({ firstParty: false })
    await f.apply()
    expect((await f.createSession("session-a")).status).toBe(201)
    expect(f.entries).toEqual([{ sessionId: "session-a", entry: undefined }])
    expect(f.host.runtimeCredentialIssuer()).toBeUndefined()
  })

  test("a project with every group off gets no entry, so no session is handed an endpoint with no tools", async () => {
    const f = fixture({ firstParty: true, groups: [] })
    await f.apply()
    expect((await f.createSession("session-a")).status).toBe(201)
    expect(f.entries).toEqual([{ sessionId: "session-a", entry: undefined }])
    expect(f.host.firstPartyMcpServer("session-a")).toBeUndefined()
  })

  test("the host exposes the issuer it injects with, for the endpoint mount to verify callers", () => {
    const f = fixture({ firstParty: true })
    expect(f.host.runtimeCredentialIssuer()).toBe(f.issuer)
    expect(f.host.runtimeCredentialIssuer()?.verify(f.issuer.current())?.workspaceId).toBe("ws-1")
  })
})
