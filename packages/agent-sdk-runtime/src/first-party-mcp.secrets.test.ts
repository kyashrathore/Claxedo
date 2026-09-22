import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "node:path"
import type { Query } from "@anthropic-ai/claude-agent-sdk"
import type { McpServer } from "@agentclientprotocol/sdk"
import type { WithInternals } from "./test-utils/class-internals"
import { acpFirstPartyMcpServer, FIRST_PARTY_MCP_CONFIG_KEY } from "./first-party-mcp"
import { createSessionTurnLifecycle } from "./harnesses/shared/turn-lifecycle"
import type { SdkRuntimeTurnInput } from "./harnesses/shared/sdk-runtime-adapter"
import { createClaudeSdkDriver, type ClaudeSdkDriverOptions } from "./harnesses/claude/driver"
import { createCursorSdkDriver } from "./harnesses/cursor/driver"
import { ACPProcess } from "./harnesses/acp/process"
import { createIdleReaper, type IdleReaper } from "./harnesses/shared/process-lifecycle"

/**
 * The bearer is a per-session secret handed to a harness process. Every log
 * line a launch writes and every environment a harness child inherits must
 * stay free of it; the header is the only place it travels.
 */
const TOKEN = "first-party-secret-sentinel-9f3c"

const provider = {
  server: (sessionId: string) => ({
    name: "claxedo",
    url: `http://127.0.0.1:2593/api/claxedo/mcp?session=${sessionId}`,
    headers: { Authorization: `Bearer ${TOKEN}` },
  }),
}

let written: string[] = []
const stderrWrite = process.stderr.write.bind(process.stderr)

beforeEach(() => {
  written = []
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
    return true
  }) as typeof process.stderr.write
})

afterEach(() => {
  process.stderr.write = stderrWrite
})

function host() {
  const lifecycle = createSessionTurnLifecycle()
  return {
    lifecycle: () => lifecycle as never,
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    bindSession() {},
    getAgentSessionId: () => "agent-session",
    getSessionForAgentSession: () => null,
    getGoal: () => null,
    getSessionConfig: () => null,
    publishGoal() {},
    async runProviderTurn() { return true },
  }
}

function turn(sessionId: string, providerID: string): SdkRuntimeTurnInput {
  return {
    sessionId,
    getAgentSessionId: () => "agent-session",
    getSessionForAgentSession: () => null,
    input: {
      parts: [{ type: "text", text: "hello" }],
      userMessageId: "user-1",
      assistantMessageId: "assistant-1",
      model: { providerID, modelID: "default" },
    },
    directory: "/repo",
    abort: new AbortController(),
    ingest() {},
    associateChild() {},
    observeSubagent: async () => ({ event: {} }),
    rebindAgentSession() {},
    model: "default",
  } as unknown as SdkRuntimeTurnInput
}

describe("first-party MCP bearer never leaves the header", () => {
  test("a Claude launch keeps it out of the child environment and every log line", async () => {
    let env: Record<string, string | undefined> | undefined
    let headers: Record<string, string> | undefined
    const query: ClaudeSdkDriverOptions["query"] = ((input) => {
      env = input.options?.env
      headers = (input.options?.mcpServers as Record<string, { headers?: Record<string, string> }>)?.claxedo?.headers
      return Object.assign((async function* () {
        yield {
          type: "result", subtype: "success", uuid: "result-1", session_id: "agent-session",
          is_error: false, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {},
        }
      })(), { close() {} }) as unknown as Query
    }) as ClaudeSdkDriverOptions["query"]
    const driver = createClaudeSdkDriver(host() as never, { query, executable: () => "/fake/claude" })
    await driver.applyConfig({ mcp: {}, [FIRST_PARTY_MCP_CONFIG_KEY]: provider })
    await driver.runTurn(turn("session-a", "claude"))

    expect(headers?.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(JSON.stringify(env)).not.toContain(TOKEN)
    expect(written.join("")).not.toContain(TOKEN)
  })

  test("a Cursor send carries it only in the server headers and logs none of it", async () => {
    let sent: { mcpServers?: Record<string, { headers?: Record<string, string> }> } | undefined
    const run = { id: "run-1", async *stream() {}, wait: async () => ({ id: "run-1", status: "finished" as const }), cancel: async () => {} }
    const agent = {
      agentId: "agent-session", model: undefined,
      send: async (_message: string, options: typeof sent) => { sent = options; return run },
      close() {}, reload: async () => {}, listArtifacts: async () => [], downloadArtifact: async () => Buffer.from([]),
      [Symbol.asyncDispose]: async () => {},
    }
    const driver = createCursorSdkDriver(host() as never, { loadAgent: async () => ({ Agent: { resume: async () => agent } as never }) })
    await driver.applyConfig({ mcp: {}, [FIRST_PARTY_MCP_CONFIG_KEY]: provider })
    await driver.runTurn(turn("session-a", "cursor"))

    expect(sent?.mcpServers?.claxedo?.headers?.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(JSON.stringify({ ...sent, mcpServers: undefined })).not.toContain(TOKEN)
    expect(written.join("")).not.toContain(TOKEN)
  })

  test("an ACP session/new logs the directory and ids, never the server headers", async () => {
    type Internals = {
      agent: { request(method: string, params: unknown): Promise<{ sessionId: string }> }
      idle: IdleReaper
      mcp: (sessionId?: string) => McpServer[]
      states: Map<string, unknown>
      loadedSessions: Set<string>
      caps: null
      transport: { alive: boolean }
      cachedConfigOptions: null
      cachedResolvedModel: null
    }
    let params: { mcpServers?: McpServer[] } | undefined
    let reaped = false
    const idle = createIdleReaper({ idleMs: 10, onIdle: () => { reaped = true } })
    const proc = Object.create(ACPProcess.prototype) as WithInternals<ACPProcess, Internals>
    Object.assign(proc, {
      agent: { request: async (_method: string, input: typeof params) => { params = input; return { sessionId: "agent-1" } } },
      idle,
      mcp: (sessionId?: string) => (sessionId ? [acpFirstPartyMcpServer(provider.server(sessionId))] : []),
      states: new Map(),
      loadedSessions: new Set(),
      caps: null,
      transport: { alive: true },
      cachedConfigOptions: null,
      cachedResolvedModel: null,
    })
    await proc.newSession(path.resolve("/work"), undefined, "session-a")
    idle.cancel()

    expect(JSON.stringify(params?.mcpServers)).toContain(TOKEN)
    expect(written.length).toBeGreaterThan(0)
    expect(written.join("")).not.toContain(TOKEN)
    expect(idle.activeLeases()).toBe(0)
    expect(reaped).toBe(false)
  })
})
