import { describe, expect, test } from "bun:test"
import type { Query } from "@anthropic-ai/claude-agent-sdk"
import { createSessionTurnLifecycle } from "../shared/turn-lifecycle"
import type { SdkRuntimeTurnInput } from "../shared/sdk-runtime-adapter"
import { FIRST_PARTY_MCP_CONFIG_KEY } from "../../first-party-mcp"
import { createClaudeSdkDriver, type ClaudeSdkDriverOptions } from "./driver"

const TOKEN = "first-party-claude-secret"

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
  const calls: Array<{ options?: { mcpServers?: Record<string, unknown>; env?: Record<string, string | undefined> } }> = []
  const query: ClaudeSdkDriverOptions["query"] = ((input) => {
    calls.push(input)
    return Object.assign((async function* () {
      yield {
        type: "result", subtype: "success", uuid: "result-1", session_id: "claude-session",
        is_error: false, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {},
      }
    })(), { close() {} }) as unknown as Query
  }) as ClaudeSdkDriverOptions["query"]
  const lifecycle = createSessionTurnLifecycle()
  const driver = createClaudeSdkDriver({
    lifecycle: () => lifecycle as never,
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    bindSession() {},
    getAgentSessionId: () => "claude-session",
    getSessionForAgentSession: () => null,
    getGoal: () => null,
    updatePermissionState() {},
    getSessionConfig: () => null,
    publishGoal() {},
    async runProviderTurn() { return true },
  }, { query, executable: () => "/fake/claude" })
  return { driver, calls }
}

function turn(sessionId: string): SdkRuntimeTurnInput {
  return {
    sessionId,
    getAgentSessionId: () => "claude-session",
    getSessionForAgentSession: () => null,
    input: {
      parts: [{ type: "text", text: "hello" }],
      userMessageId: "user-1",
      assistantMessageId: "assistant-1",
      model: { providerID: "claude", modelID: "sonnet" },
    },
    directory: "/repo",
    abort: new AbortController(),
    ingest() {},
    associateChild() {},
    observeSubagent: async () => ({ event: {} }),
    rebindAgentSession() {},
    model: "sonnet",
  } as unknown as SdkRuntimeTurnInput
}

describe("Claude first-party MCP injection", () => {
  test("hands the SDK one http entry named claxedo whose URL names the session, beside the user's servers", async () => {
    const { driver, calls } = fixture()
    await driver.applyConfig({
      mcp: { docs: { name: "docs", source: "user", transport: "remote", url: "http://docs.test/mcp", headers: {} } },
      [FIRST_PARTY_MCP_CONFIG_KEY]: firstPartyMcp(),
    })
    await driver.runTurn(turn("session-a"))
    await driver.runTurn(turn("session-b"))

    expect(calls[0]?.options?.mcpServers).toEqual({
      docs: { type: "http", url: "http://docs.test/mcp", headers: {} },
      claxedo: {
        type: "http",
        url: "http://127.0.0.1:2593/api/claxedo/mcp?session=session-a",
        headers: { Authorization: `Bearer ${TOKEN}` },
      },
    })
    expect(calls[1]?.options?.mcpServers?.claxedo).toEqual({
      type: "http",
      url: "http://127.0.0.1:2593/api/claxedo/mcp?session=session-b",
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
  })

  test("keeps the bearer out of the harness child environment", async () => {
    const { driver, calls } = fixture()
    await driver.applyConfig({ mcp: {}, [FIRST_PARTY_MCP_CONFIG_KEY]: firstPartyMcp() })
    await driver.runTurn(turn("session-a"))
    expect(JSON.stringify(calls[0]?.options?.env)).not.toContain(TOKEN)
  })

  test("injects nothing when the runtime supplies no provider", async () => {
    const { driver, calls } = fixture()
    await driver.applyConfig({ mcp: {} })
    await driver.runTurn(turn("session-a"))
    expect(calls[0]?.options?.mcpServers).toBeUndefined()
  })
})
