import path from "node:path"
import { describe, expect, test } from "bun:test"
import type { McpServer } from "@agentclientprotocol/sdk"
import type { WithInternals } from "../../test-utils/class-internals"
import { acpFirstPartyMcpServer } from "../../first-party-mcp"
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
    idle: { touch() {} },
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
