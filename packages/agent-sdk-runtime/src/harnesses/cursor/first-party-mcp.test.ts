import { describe, expect, test } from "bun:test"
import { createSessionTurnLifecycle } from "../shared/turn-lifecycle"
import type { SdkRuntimeTurnInput } from "../shared/sdk-runtime-adapter"
import { FIRST_PARTY_MCP_CONFIG_KEY } from "../../first-party-mcp"
import { createCursorSdkDriver } from "./driver"

const TOKEN = "first-party-cursor-secret"

function firstPartyMcp() {
  return {
    server: (sessionId: string) => ({
      name: "claxedo",
      url: `http://127.0.0.1:2593/api/claxedo/mcp?session=${sessionId}`,
      headers: { Authorization: `Bearer ${TOKEN}` },
    }),
  }
}

function fixture() {
  const created: Array<{ mcpServers?: Record<string, unknown> }> = []
  const sent: Array<{ mcpServers?: Record<string, unknown> }> = []
  const run = {
    id: "run-1",
    async *stream() {},
    wait: async () => ({ id: "run-1", status: "finished" as const }),
    cancel: async () => {},
  }
  const agent = {
    agentId: "cursor-agent-1",
    model: undefined,
    send: async (_message: string, options: { mcpServers?: Record<string, unknown> }) => {
      sent.push(options)
      return run
    },
    close() {},
    reload: async () => {},
    listArtifacts: async () => [],
    downloadArtifact: async () => Buffer.from([]),
    [Symbol.asyncDispose]: async () => {},
  }
  const lifecycle = createSessionTurnLifecycle()
  const driver = createCursorSdkDriver({
    lifecycle: () => lifecycle as never,
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    bindSession() {},
    getAgentSessionId: () => "cursor-agent-1",
    getSessionForAgentSession: () => null,
    getGoal: () => null,
    updatePermissionState() {},
    getSessionConfig: () => null,
    publishGoal() {},
    async runProviderTurn() { return true },
  }, {
    loadAgent: async () => ({
      Agent: {
        create: async (options: { mcpServers?: Record<string, unknown> }) => {
          created.push(options)
          return agent
        },
        resume: async () => agent,
      } as never,
    }),
  })
  return { driver, created, sent }
}

function turn(sessionId: string): SdkRuntimeTurnInput {
  return {
    sessionId,
    getAgentSessionId: () => "cursor-agent-1",
    getSessionForAgentSession: () => null,
    input: {
      parts: [{ type: "text", text: "hello" }],
      userMessageId: "user-1",
      assistantMessageId: "assistant-1",
      model: { providerID: "cursor", modelID: "auto" },
    },
    directory: "/repo",
    abort: new AbortController(),
    ingest() {},
    associateChild() {},
    observeSubagent: async () => ({ event: {} }),
    rebindAgentSession() {},
    model: "auto",
  } as unknown as SdkRuntimeTurnInput
}

describe("Cursor first-party MCP injection", () => {
  test("names the session on every send and leaves Agent.create with the user's servers only", async () => {
    const { driver, created, sent } = fixture()
    await driver.applyConfig({
      mcp: { docs: { name: "docs", source: "user", transport: "remote", url: "http://docs.test/mcp", headers: {} } },
      [FIRST_PARTY_MCP_CONFIG_KEY]: firstPartyMcp(),
    })
    await driver.createAgentSession({ directory: "/repo", model: "auto", sessionId: "session-a" })
    await driver.runTurn(turn("session-a"))
    await driver.runTurn(turn("session-b"))

    expect(created[0]?.mcpServers).toEqual({ docs: { type: "http", url: "http://docs.test/mcp", headers: {} } })
    expect(sent[0]?.mcpServers).toEqual({
      docs: { type: "http", url: "http://docs.test/mcp", headers: {} },
      claxedo: {
        type: "http",
        url: "http://127.0.0.1:2593/api/claxedo/mcp?session=session-a",
        headers: { Authorization: `Bearer ${TOKEN}` },
      },
    })
    expect(sent[1]?.mcpServers?.claxedo).toEqual({
      type: "http",
      url: "http://127.0.0.1:2593/api/claxedo/mcp?session=session-b",
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
  })

  test("sends no mcpServers when neither the user nor the runtime supplies any", async () => {
    const { driver, sent } = fixture()
    await driver.applyConfig({ mcp: {} })
    await driver.runTurn(turn("session-a"))
    expect(sent[0]?.mcpServers).toBeUndefined()
  })
})
