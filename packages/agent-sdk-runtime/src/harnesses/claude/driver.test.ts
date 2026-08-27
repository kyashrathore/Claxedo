import { describe, expect, test } from "bun:test"
import {
  CLAUDE_FORWARD_SUBAGENT_TEXT,
  claudeSystemPrompt,
  claudeSpawnEnv,
  createClaudeSdkDriver,
  ingestClaudeSdkMessage,
} from "./driver"
import { SDK_MODEL_CATALOG } from "../../sdk-model-catalog"

function driver() {
  return createClaudeSdkDriver({
    lifecycle: () => ({ set() {}, delete() {}, get() {}, activeTurns: new Map() }),
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    bindSession() {},
  } as never)
}

describe("Claude SDK driver", () => {
  test("appends a handoff transcript to Claude Code's canonical system prompt", () => {
    expect(claudeSystemPrompt("prior conversation")).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "prior conversation",
    })
    expect(claudeSystemPrompt()).toBeUndefined()
  })

  test("U5: measures routed nested SDK frames below the forwarding thresholds", async () => {
    const childText = [
      "Inspecting authentication entry points.",
      "Reading the session middleware.",
      "Searching for token validation.",
      "Checking the failure path.",
      "Found one stale authorization branch.",
      "The child review is complete.",
    ]
    const parentMessages = Array.from({ length: 7 }, (_, index) => ({
      type: "assistant",
      uuid: `assistant-parent-${index}`,
      session_id: "sdk-session-measurement",
      parent_tool_use_id: null,
      message: {
        content: index === 0
          ? [{
              type: "tool_use",
              id: "tool-agent-measurement",
              name: "Agent",
              input: { description: "Review auth", subagent_type: "code-reviewer" },
            }]
          : [{ type: "text", text: `Parent progress ${index}` }],
      },
    }))
    const childMessages = childText.map((value, index) => ({
      type: "assistant",
      uuid: `assistant-child-${index}`,
      session_id: "sdk-session-measurement",
      parent_tool_use_id: "tool-agent-measurement",
      message: { content: [{ type: "text", text: value }] },
    }))
    const ingested: unknown[][] = []
    const input = {
      observeSubagent() {
        return Promise.resolve({ event: {} })
      },
      ingest(...value: unknown[]) {
        ingested.push(value)
      },
      rebindAgentSession() {},
    } as never

    for (const message of [...parentMessages, ...childMessages]) {
      await ingestClaudeSdkMessage(input, message as never)
    }

    const parentFrames = ingested.filter((value) => (value[2] as { kind: string }).kind === "parent")
    const childFrames = ingested.filter((value) => (value[2] as { kind: string }).kind === "child")
    const forwardedBytes = childFrames.reduce((total, value) => {
      const payload = (value[0] as { payload: { message: { content: Array<{ text?: string }> } } }).payload
      return total + payload.message.content.reduce(
        (bytes, part) => bytes + new TextEncoder().encode(part.text ?? "").byteLength,
        0,
      )
    }, 0)

    expect(parentFrames).toHaveLength(7)
    expect(childFrames).toHaveLength(6)
    expect(childFrames.length / parentFrames.length).toBeLessThan(2)
    expect(forwardedBytes).toBeLessThan(5 * 1024 * 1024)
    expect(CLAUDE_FORWARD_SUBAGENT_TEXT).toBe(true)
  })

  test("U5: admits tool and task observations before routing child-owned SDK messages", async () => {
    const observed: unknown[] = []
    const ingested: unknown[][] = []
    const rebound: string[] = []
    const input = {
      observeSubagent(value: unknown) {
        observed.push(value)
        return Promise.resolve({ event: {} })
      },
      ingest(...value: unknown[]) {
        ingested.push(value)
      },
      rebindAgentSession(value: string) {
        rebound.push(value)
      },
    } as never

    await ingestClaudeSdkMessage(input, {
      type: "assistant",
      uuid: "assistant-parent-1",
      session_id: "sdk-session-1",
      parent_tool_use_id: null,
      message: {
        content: [{
          type: "tool_use",
          id: "tool-agent-1",
          name: "Agent",
          input: { description: "Review auth", subagent_type: "code-reviewer" },
        }],
      },
    } as never)
    expect(observed).toMatchObject([{
      observation: {
        toolCallId: "tool-agent-1",
        toolCallRole: "spawn",
        status: "pending",
        transcript: { kind: "messages" },
      },
      correlationKeys: ["tool-agent-1"],
    }])
    expect(ingested[0]?.[2]).toEqual({ kind: "parent" })

    await ingestClaudeSdkMessage(input, {
      type: "system",
      subtype: "task_started",
      uuid: "task-start-1",
      session_id: "sdk-session-1",
      task_id: "task-1",
      tool_use_id: "tool-agent-1",
      description: "Review auth",
      subagent_type: "code-reviewer",
    } as never)
    expect(observed[1]).toMatchObject({
      observation: { stableCorrelationId: "task-1", toolCallId: "tool-agent-1", status: "running" },
      correlationKeys: ["task-1", "tool-agent-1"],
    })

    await ingestClaudeSdkMessage(input, {
      type: "assistant",
      uuid: "assistant-child-1",
      session_id: "sdk-session-1",
      parent_tool_use_id: "tool-agent-1",
      message: { content: [{ type: "tool_use", id: "tool-read-1", name: "Read", input: {} }] },
    } as never)
    expect(ingested[2]?.[2]).toEqual({ kind: "child", correlationKey: "tool-agent-1" })
    expect(rebound).toEqual(["sdk-session-1", "sdk-session-1", "sdk-session-1"])
  })

  test("U5: admits the structured Agent identity without parsing the tool-result text", async () => {
    const observed: unknown[] = []
    await ingestClaudeSdkMessage({
      observeSubagent(value: unknown) {
        observed.push(value)
        return Promise.resolve({ event: {} })
      },
      ingest() {},
      rebindAgentSession() {},
    } as never, {
      type: "user",
      uuid: "agent-result-1",
      session_id: "sdk-session-1",
      parent_tool_use_id: null,
      message: {
        content: [{ type: "tool_result", tool_use_id: "tool-agent-1", content: "opaque trailer" }],
      },
      tool_use_result: {
        status: "completed",
        agentId: "agent-42",
        content: [{ type: "text", text: "Review complete" }],
        totalTokens: 321,
      },
    } as never)

    expect(observed).toMatchObject([{
      observation: {
        toolCallId: "tool-agent-1",
        providerId: "agent-42",
        providerKind: "claude-agent",
        status: "completed",
      },
    }])
  })

  test("scrubs the local document installation secret from the child environment", () => {
    expect(claudeSpawnEnv({
      PATH: "/bin",
      CLAXEDO_LOCAL_DOCUMENT_BROKER_TOKEN: "installation-secret",
    })).toEqual({ PATH: "/bin" })
  })

  /**
   * The live list comes from the SDK (`Query.supportedModels()`); `SDK_MODEL_CATALOG`
   * is the hand-maintained fallback served until a probe succeeds. These assertions
   * read the catalog rather than restating it: a copy here went stale against the
   * catalog (it still named `claude-sonnet-4-6`/`claude-opus-4-6`) and nothing caught
   * it, because a duplicated list only ever tests the duplicate.
   */
  test("serves the static Claude model catalog before any live probe", () => {
    const catalog = SDK_MODEL_CATALOG.claude

    expect(driver().peekConfigOptions(catalog[0].id)).toEqual([{
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: catalog[0].id,
      selectOptions: catalog.map((model) => ({ id: model.id, name: model.name })),
    }])
  })

  test("every fallback model is servable to the picker: unique id, non-empty name", () => {
    const catalog = SDK_MODEL_CATALOG.claude

    expect(catalog.length).toBeGreaterThan(0)
    expect(new Set(catalog.map((model) => model.id)).size).toBe(catalog.length)
    for (const model of catalog) {
      expect(model.id).toMatch(/^claude-/)
      expect(model.name.length).toBeGreaterThan(0)
    }
  })

  test("an unknown current model falls back to the first catalog entry", () => {
    const [option] = driver().peekConfigOptions("claude-from-a-future-release")

    expect(option?.currentValue).toBe(SDK_MODEL_CATALOG.claude[0].id)
  })
})
