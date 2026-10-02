import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { startScriptedAcpWebSocket } from "../../e2e/harness/acp/websocket"
import { startScriptedAcpHttp } from "../../e2e/harness/acp/http"
import { readAcpRequests } from "../../e2e/harness/acp/requests"
import { acpScriptToken, writeAcpScript } from "../../e2e/harness/acp/script"
import { filterMcpServers } from "../capabilities/mcp-filter"
import { AcpTransport } from "../transports/acp"
import type { McpCapabilities } from "@agentclientprotocol/sdk"
import type { AcpConnectionOptions } from "../transports/acp/connection"
import type { PendingRequest, ProjectedMcpServer } from "../contract"
import { setupConformance, type ConformanceBackend } from "./test-support/run"

type Backend = ConformanceBackend & { connection: AcpConnectionOptions }
type Context = Awaited<ReturnType<typeof setupConformance>>

async function backend(kind: "websocket" | "streamable-http", restoreMode: "load" | "resume", mcpCapabilities?: McpCapabilities): Promise<Backend> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acp-isolation-"))
  await writeAcpScript(directory, "permission", { steps: [
    { kind: "permission", tool: "execute", title: "Hold this workspace's turn" },
    { kind: "text", text: "released" },
  ] })
  const peer = kind === "websocket"
    ? await startScriptedAcpWebSocket(directory, { restoreMode, mcpCapabilities })
    : await startScriptedAcpHttp(directory, { restoreMode, mcpCapabilities })
  return {
    directory, connection: { kind, url: peer.url }, locality: "remote",
    harness: { id: "scripted-acp", access: "connection" },
    model: { providerID: "scripted-acp", modelID: "default" }, owner: { kind: "machine-owner" },
    credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "initial" },
    projection: { generation: "initial", pluginRoots: [], notApplied: [], mcpServers: [
      { kind: "http", name: "http", origin: "configured", url: "https://http.example.test/mcp", headers: { Authorization: "Bearer http-token" } },
      { kind: "sse", name: "sse", origin: "configured", url: "https://sse.example.test/sse" },
      { kind: "stdio", name: "stdio", origin: "configured", command: "never-run" },
      { kind: "http", name: "plugin", origin: "plugin", url: "https://plugin.example.test/mcp", headers: { Authorization: "Bearer plugin-token" } },
    ] },
    configureServices(services) {
      services.firstPartyMcp = () => ({ kind: "http", name: "claxedo", url: "http://localhost/api/claxedo/mcp",
        headers: { Authorization: "Bearer first-party-token" } })
    },
    unrunnableTurn: (turn) => turn,
    async close() { await peer.close(); await fs.rm(directory, { recursive: true, force: true }) },
  }
}

const capabilityCases: McpCapabilities[] = [{}, { http: true }, { sse: true }, { http: true, sse: true }]

function setup(kind: "websocket" | "streamable-http" = "websocket", restoreMode: "load" | "resume" = "resume", mcpCapabilities?: McpCapabilities) {
  return setupConformance({ name: "ACP isolation", backend: () => backend(kind, restoreMode, mcpCapabilities),
    makeTransport: (services, state) => new AcpTransport(services, (state as Backend).connection, filterMcpServers),
  })
}

for (const kind of ["websocket", "streamable-http"] as const) {
  for (const restoreMode of ["load", "resume"] as const) {
    for (const capabilities of capabilityCases) {
      test(`remote ACP ${kind} ${restoreMode} sends only declared MCP transports: ${JSON.stringify(capabilities)}`, async () => {
        let context: Context | undefined
        try {
          context = await setup(kind, restoreMode, capabilities)
          expect(context.transport.fork).toBeDefined()
          await context.transport.fork!.fork(context.session, "message", "child")
          const binding = context.session.binding
          await context.transport.close(context.session)
          await context.transport.attach({ ...context.start, binding, upstreamHasTurns: false }, context.sessionBroker)
          const methods = ["session/new", "session/fork", `session/${restoreMode}`]
          const calls = (await readAcpRequests(context.backend.directory)).filter((row) => methods.includes(row.method))
          expect(calls.map((row) => row.method)).toEqual(methods)
          const expected = context.start.projection.mcpServers.filter((server) =>
            server.origin === "configured" && server.kind !== "stdio" && capabilities[server.kind])
          for (const call of calls) {
            expect(call.params.mcpServers).toEqual(expected.map(wireServer))
            expect(JSON.stringify(call)).not.toContain("first-party-token")
            expect(JSON.stringify(call)).not.toContain("plugin-token")
          }
        } finally {
          await context?.close()
        }
      })
    }
  }
}

function wireServer(server: ProjectedMcpServer) {
  if (server.kind === "stdio") throw new Error("Unexpected stdio server")
  return { type: server.kind, name: server.name, url: server.url,
    headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value })) }
}

async function collect(context: Context, text: string) {
  const events = []
  for await (const event of context.transport.send(context.session, context.turn(text), context.turnBroker())) events.push(event)
  return events
}

function holdTurn(context: Context) {
  const pending = Promise.withResolvers<PendingRequest>()
  const publish = context.ports.publish.bind(context.ports)
  context.ports.publish = async (event, request) => {
    await publish(event, request)
    if (request?.request.kind === "permission") pending.resolve(request)
  }
  const settled = collect(context, acpScriptToken("permission"))
  return { pending: pending.promise, settled }
}

async function release(context: Context, pending: PendingRequest) {
  expect((await context.owner.broker.answer(pending.request.requestId,
    { kind: "permission", decision: "allow_once" }, { sessionId: context.session.binding.sessionId })).ok).toBe(true)
}

test("independent ACP instances restart idle and completed workspaces while another turn stays active", async () => {
  const first = await setup()
  const second = await setup()
  try {
    expect(first.backend.directory).not.toBe(second.backend.directory)
    const otherTurn = holdTurn(second)
    const otherPending = await otherTurn.pending
    const credentials = { ...first.start.credentials, leaseGeneration: "rotated" }
    expect(await first.transport.configure(first.session, { credentials })).toEqual({ state: "applied" })
    const ownTurn = holdTurn(first)
    const ownPending = await ownTurn.pending
    expect(await first.transport.configure(first.session, { credentials: { ...credentials, leaseGeneration: "again" } }))
      .toEqual({ state: "deferred", until: "after-active-turns" })
    await release(first, ownPending)
    await ownTurn.settled
    expect((await collect(first, "fresh turn")).some(({ event }) => event.type === "finish")).toBe(true)
    expect((await readAcpRequests(first.backend.directory)).filter((row) => row.method === "session/resume")).toHaveLength(2)
    expect(second.owner.broker.list({ sessionId: second.session.binding.sessionId })).toContainEqual(otherPending)
    expect((await readAcpRequests(second.backend.directory)).some((row) => row.method === "session/resume")).toBe(false)
    await release(second, otherPending)
    expect((await otherTurn.settled).some(({ event }) => event.type === "finish")).toBe(true)
  } finally { await Promise.all([first.close(), second.close()]) }
})
