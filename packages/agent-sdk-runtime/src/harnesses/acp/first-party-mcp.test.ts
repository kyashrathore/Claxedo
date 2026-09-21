import path from "node:path"
import { describe, expect, test } from "bun:test"
import type { AnyMessage, McpServer } from "@agentclientprotocol/sdk"
import type { WithInternals } from "../../test-utils/class-internals"
import { acpFirstPartyMcpServer, FIRST_PARTY_MCP_CONFIG_KEY } from "../../first-party-mcp"
import { MemoryRuntimeStore } from "../../stores/memory"
import { AcpHarnessAdapter, type AcpRuntimeStore } from "./index"
import { ACPProcess } from "./process"

const TOKEN = "first-party-acp-secret"

type ProcessInternals = {
  agent: { request(method: string, params: unknown): Promise<{ sessionId: string }> }
  idle: { touch(): void }
  mcp: (sessionId?: string) => McpServer[]
  states: Map<string, unknown>
  caps: null
  transport: { alive: boolean }
  cachedConfigOptions: null
  cachedResolvedModel: null
}

/**
 * An `ACPProcess` whose connection is scripted and whose MCP closure is the
 * session-aware one the process manager supplies: the user's servers for every
 * session plus the first-party entry for the session named.
 */
function acpProcess() {
  const requests: Array<{ method: string; params: { mcpServers?: McpServer[] } }> = []
  const user: McpServer = { name: "docs", command: "docs-mcp", args: [], env: [] }
  const proc = Object.create(ACPProcess.prototype) as WithInternals<ACPProcess, ProcessInternals>
  Object.assign(proc, {
    agent: {
      request: async (method: string, params: { mcpServers?: McpServer[] }) => {
        requests.push({ method, params })
        return { sessionId: `agent-${requests.length}`, configOptions: [], modes: { availableModes: [], currentModeId: "" } }
      },
    },
    idle: { touch() {}, lease: () => ({ release() {} }) },
    mcp: (sessionId?: string) => [
      user,
      ...(sessionId
        ? [acpFirstPartyMcpServer({
            name: "claxedo",
            url: `http://127.0.0.1:2593/api/claxedo/mcp?session=${sessionId}`,
            headers: { Authorization: `Bearer ${TOKEN}` },
          })]
        : []),
    ],
    states: new Map(),
    loadedSessions: new Set(),
    caps: null,
    transport: { alive: true },
    cachedConfigOptions: null,
    cachedResolvedModel: null,
  })
  return { proc, requests, user }
}

const claxedo = (sessionId: string): McpServer => ({
  type: "http",
  name: "claxedo",
  url: `http://127.0.0.1:2593/api/claxedo/mcp?session=${sessionId}`,
  headers: [{ name: "Authorization", value: `Bearer ${TOKEN}` }],
})

describe("ACP first-party MCP injection", () => {
  test("session/new carries the user's servers plus the claxedo entry for the session it opens", async () => {
    const { proc, requests, user } = acpProcess()
    await proc.newSession(path.resolve("/work"), undefined, "session-a")
    await proc.newSession(path.resolve("/work"), undefined, "session-b")
    expect(requests.map((row) => row.params.mcpServers)).toEqual([
      [user, claxedo("session-a")],
      [user, claxedo("session-b")],
    ])
  })

  test("session/fork names the forked session, not the parent", async () => {
    const { proc, requests } = acpProcess()
    await proc.newSession(path.resolve("/work"), undefined, "parent")
    await proc.forkSession("agent-1", path.resolve("/work"), "child")
    expect(requests.at(-1)?.params.mcpServers?.at(-1)).toEqual(claxedo("child"))
  })

  test("a caller that names no session opens the session with the user's servers only", async () => {
    const { proc, requests, user } = acpProcess()
    await proc.newSession(path.resolve("/work"))
    expect(requests[0]?.params.mcpServers).toEqual([user])
  })
})

/**
 * An ACP agent on the wire: the adapter's own transport factory hands it the
 * message stream, so a request only reaches `requests` after the real
 * `applyConfig` → `createSession` → `session/new` path produced it.
 */
function scriptedAcpAgent() {
  const requests: Array<{ method: string; params: { mcpServers?: McpServer[] } }> = []
  let push: (message: AnyMessage) => void = () => {}
  const readable = new ReadableStream<AnyMessage>({
    start(controller) {
      push = (message) => controller.enqueue(message)
    },
  })
  let opened = 0
  const writable = new WritableStream<AnyMessage>({
    write(message) {
      if (!("method" in message) || !("id" in message)) return
      const { id, method, params } = message
      requests.push({ method, params: (params ?? {}) as { mcpServers?: McpServer[] } })
      if (method === "initialize") {
        push({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: {} } })
        return
      }
      if (method === "session/new") {
        opened += 1
        push({ jsonrpc: "2.0", id, result: { sessionId: `agent-${opened}` } })
      }
    },
  })
  return { requests, stream: { readable, writable } }
}

describe("ACP adapter first-party MCP end to end", () => {
  test("createSession sends session/new with the claxedo entry naming that session and carrying its bearer", async () => {
    const agent = scriptedAcpAgent()
    const adapter = new AcpHarnessAdapter({
      connection: { kind: "process", command: "fake-acp" },
      harness: "openclaw",
      store: new MemoryRuntimeStore() as unknown as AcpRuntimeStore,
      createTransport: () => ({
        kind: "stdio",
        stream: agent.stream,
        metadata: {},
        pid: 1,
        alive: true,
        dispose() {},
      }),
    })
    try {
      await adapter.applyConfig({
        mcp: { docs: { name: "docs", source: "user", transport: "stdio", command: "docs-mcp", args: [], env: {} } },
        [FIRST_PARTY_MCP_CONFIG_KEY]: {
          server: (sessionId: string) => ({
            name: "claxedo",
            url: `http://127.0.0.1:2593/api/claxedo/mcp?session=${sessionId}`,
            headers: { Authorization: `Bearer ${TOKEN}` },
          }),
        },
      })
      await adapter.createSession(path.resolve("/work"), "First party", "session-a")

      const opened = agent.requests.filter((row) => row.method === "session/new")
      expect(opened).toHaveLength(1)
      expect(opened[0]?.params.mcpServers).toEqual([
        { name: "docs", command: "docs-mcp", args: [], env: [] },
        claxedo("session-a"),
      ])
    } finally {
      await adapter.dispose?.()
    }
  })
})
