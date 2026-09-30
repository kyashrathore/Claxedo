import { describe, expect, test } from "bun:test"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { CLAUDE_SUBAGENT_USAGE_METHOD, type ClaudeSubagentUsage } from "./request-stream"
import { claudeRuntime as runtime } from "../test-support/runtime"

function sdkFrame(agent: ReturnType<typeof runtime>, payload: Record<string, unknown>) {
  return agent.ingest({ source: "claude.sdk.message", payload }).events
}

function streamFrame(event: Record<string, unknown>) {
  return { type: "stream_event", uuid: `stream-${String(event.type)}`, session_id: "sdk-session-1", parent_tool_use_id: null, event }
}

function messageStart(id: string, usage: Record<string, unknown>) {
  return streamFrame({ type: "message_start", message: { id, type: "message", role: "assistant", model: "claude-opus", content: [], usage } })
}

function messageDelta(usage: Record<string, unknown>) {
  return streamFrame({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage })
}

function assistantFrame(id: string, usage: Record<string, unknown>, owner: string | null = null) {
  return { type: "assistant", uuid: `assistant-${id}`, session_id: "sdk-session-1", parent_tool_use_id: owner, message: { id, content: [], usage } }
}

function resultFrame(usage: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { type: "result", subtype: "success", is_error: false, uuid: "result", session_id: "sdk-session-1", usage, ...extra }
}

function streamedRequest(id: string, opening: Record<string, unknown>, finalOutput: number) {
  return [
    messageStart(id, opening),
    assistantFrame(id, opening),
    messageDelta({ ...opening, output_tokens: finalOutput }),
    streamFrame({ type: "message_stop" }),
  ]
}

function meteredTokens(events: AgentRuntimeEvent[]) {
  return events.flatMap((event) => event.type === "usage" ? [event.observation?.tokens] : []).at(-1)
}

const FIRST_REQUEST = {
  input_tokens: 3,
  cache_creation_input_tokens: 200,
  cache_read_input_tokens: 1000,
  cache_creation: { ephemeral_1h_input_tokens: 200, ephemeral_5m_input_tokens: 0 },
  output_tokens: 2,
}

const SECOND_REQUEST = {
  input_tokens: 5,
  cache_creation_input_tokens: 50,
  cache_read_input_tokens: 1200,
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 50 },
  output_tokens: 1,
}

const TWO_REQUEST_FINALS = { input: 8, output: 900 + 4000, reasoning: null, cache: { read: 2200, write: 250, write1h: 200 } }

describe("claudeSdkAdapter", () => {
  test("U5: subagent progress usage does not update the parent context gauge", () => {
    expect(runtime().ingest({
      source: "claude.sdk.message",
      payload: {
        type: "system",
        subtype: "task_progress",
        uuid: "task-progress-1",
        session_id: "sdk-session-1",
        task_id: "task-1",
        description: "Review",
        usage: { total_tokens: 5000, tool_uses: 8, duration_ms: 2000 },
        summary: "Checking files",
      },
    }).events).not.toContainEqual(expect.objectContaining({ type: "usage" }))
  })

  test("a result completes the turn and reports its metered usage against the model's context window", () => {
    const agent = runtime()
    const opening = {
      input_tokens: 4,
      cache_creation_input_tokens: 2715,
      cache_read_input_tokens: 21144,
      output_tokens: 3,
    }
    for (const payload of streamedRequest("req-1", opening, 679)) sdkFrame(agent, payload)

    expect(agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "sdk-session-result",
        usage: { ...opening, output_tokens: 679 },
        modelUsage: { "claude-opus-4-6": { contextWindow: 200000 } },
      },
    }).events).toMatchObject([
      {
        type: "usage",
        contextSize: 200000,
        contextUsed: 24542,
        observation: {
          kind: "cumulative",
          nativeSessionId: "sdk-session-result",
          tokens: {
            input: 4,
            output: 679,
            reasoning: null,
            cache: { read: 21144, write: 2715 },
          },
        },
      },
      { type: "session-status", status: "idle" },
      { type: "finish", sessionId: "sdk-session-result" },
    ])
  })

  test("meters an assistant frame's request once by message id, apart from a child's requests", () => {
    const agent = runtime()
    const assistant = (id: string, usage: Record<string, number>, owner: string | null = null) =>
      sdkFrame(agent, assistantFrame(id, usage, owner))

    expect(meteredTokens(assistant("req-1", { input_tokens: 100, cache_read_input_tokens: 500, output_tokens: 20 })))
      .toEqual({ input: 100, output: 20, reasoning: null, cache: { read: 500, write: null } })

    expect(meteredTokens(assistant("req-1", { input_tokens: 100, cache_read_input_tokens: 500, output_tokens: 45 })))
      .toEqual({ input: 100, output: 45, reasoning: null, cache: { read: 500, write: null } })

    expect(meteredTokens(assistant("req-2", { input_tokens: 30, cache_read_input_tokens: 600, output_tokens: 10 })))
      .toEqual({ input: 130, output: 55, reasoning: null, cache: { read: 1100, write: null } })

    expect(meteredTokens(assistant("req-child", { input_tokens: 999, output_tokens: 999 }, "tool-1")))
      .toEqual({ input: 999, output: 999, reasoning: null, cache: { read: null, write: null } })

    expect(meteredTokens(assistant("req-3", { input_tokens: 7, cache_read_input_tokens: 40, output_tokens: 3 })))
      .toEqual({ input: 137, output: 58, reasoning: null, cache: { read: 1140, write: null } })
  })

  test("a turn that fails before its result meters each request's final output, not its opening snapshot", () => {
    const agent = runtime()
    const events = [
      ...streamedRequest("req-1", FIRST_REQUEST, 900),
      messageStart("req-2", SECOND_REQUEST),
      messageDelta({ input_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens: 4000 }),
      assistantFrame("req-2", SECOND_REQUEST),
      {
        type: "assistant",
        uuid: "assistant-failed",
        session_id: "sdk-session-1",
        parent_tool_use_id: null,
        error: "server_error",
        message: { id: "req-failed", content: [{ type: "text", text: "API Error: 500" }] },
      },
    ].flatMap((payload) => sdkFrame(agent, payload))

    expect(events).toContainEqual(expect.objectContaining({ type: "error" }))
    expect(meteredTokens(events)).toEqual(TWO_REQUEST_FINALS)
  })

  test("a result closes the turn with the metered sum, counting no request twice", () => {
    const agent = runtime()
    for (const payload of [
      ...streamedRequest("req-1", FIRST_REQUEST, 900),
      ...streamedRequest("req-2", SECOND_REQUEST, 4000),
    ]) sdkFrame(agent, payload)

    const closing = sdkFrame(agent, resultFrame({
      input_tokens: 8,
      cache_creation_input_tokens: 250,
      cache_read_input_tokens: 2200,
      output_tokens: 4900,
      cache_creation: { ephemeral_1h_input_tokens: 200, ephemeral_5m_input_tokens: 50 },
    }, { modelUsage: { "claude-opus": { contextWindow: 200000 } } }))

    expect(closing).toMatchObject([
      { type: "usage", contextSize: 200000, contextUsed: 5 + 4000 + 1200 + 50 },
      { type: "session-status", status: "idle" },
      { type: "finish", sessionId: "sdk-session-1" },
    ])
    expect(meteredTokens(closing)).toEqual(TWO_REQUEST_FINALS)
  })

  test("a query that ends two CLI turns meters both, whether or not the first result is ingested", () => {
    for (const ingestFirstResult of [true, false]) {
      const agent = runtime()
      for (const payload of streamedRequest("req-1", FIRST_REQUEST, 900)) sdkFrame(agent, payload)
      if (ingestFirstResult) {
        sdkFrame(agent, resultFrame({ input_tokens: 3, cache_creation_input_tokens: 200, cache_read_input_tokens: 1000, output_tokens: 900 }))
      }
      for (const payload of streamedRequest("req-2", SECOND_REQUEST, 4000)) sdkFrame(agent, payload)

      const closing = sdkFrame(agent, resultFrame({ input_tokens: 5, cache_creation_input_tokens: 50, cache_read_input_tokens: 1200, output_tokens: 4000 }))

      expect(meteredTokens(closing)).toEqual(TWO_REQUEST_FINALS)
    }
  })

  test("a child's requests meter the child's own total, corrected by its transcript, and never the parent's", () => {
    const agent = runtime()
    for (const payload of streamedRequest("req-parent", FIRST_REQUEST, 900)) sdkFrame(agent, payload)
    const childOpening = { input_tokens: 4, cache_read_input_tokens: 700, cache_creation_input_tokens: 30, cache_creation: { ephemeral_1h_input_tokens: 30, ephemeral_5m_input_tokens: 0 }, output_tokens: 2 }
    const correction = (id: string, usage: Record<string, unknown>) => agent.ingest({
      source: "claude.sdk",
      method: CLAUDE_SUBAGENT_USAGE_METHOD,
      payload: { parent_tool_use_id: "tool-agent-1", session_id: "sdk-session-1", message: { id, usage } } satisfies ClaudeSubagentUsage,
    }).events

    expect(meteredTokens(sdkFrame(agent, assistantFrame("req-child-1", childOpening, "tool-agent-1"))))
      .toEqual({ input: 4, output: 2, reasoning: null, cache: { read: 700, write: 30, write1h: 30 } })
    expect(meteredTokens(correction("req-child-1", { ...childOpening, output_tokens: 310 })))
      .toEqual({ input: 4, output: 310, reasoning: null, cache: { read: 700, write: 30, write1h: 30 } })
    expect(correction("req-child-1", childOpening)).toEqual([])

    const closing = sdkFrame(agent, resultFrame({ input_tokens: 3, cache_creation_input_tokens: 200, cache_read_input_tokens: 1000, output_tokens: 900 }))
    expect(meteredTokens(closing)).toEqual({ input: 3, output: 900, reasoning: null, cache: { read: 1000, write: 200, write1h: 200 } })
  })

  test("each observation names the model that served its requests, one stream per model", () => {
    const agent = runtime()
    const start = (id: string, model: string, usage: Record<string, unknown>) =>
      sdkFrame(agent, streamFrame({ type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], usage } }))
    const observed = (events: AgentRuntimeEvent[]) => events.flatMap((event) => event.type === "usage" && event.observation
      ? [{ scope: event.observation.scope, model: event.observation.model, input: event.observation.tokens.input }]
      : [])

    expect(observed(start("req-1", "claude-opus-4-6", { input_tokens: 10, output_tokens: 1 }))).toEqual([
      { scope: undefined, model: "claude-opus-4-6", input: 10 },
    ])
    expect(observed(start("req-2", "claude-sonnet-4-5", { input_tokens: 20, output_tokens: 1 }))).toEqual([
      { scope: "main@claude-sonnet-4-5", model: "claude-sonnet-4-5", input: 20 },
    ])
    expect(observed(start("req-3", "claude-opus-4-6", { input_tokens: 30, output_tokens: 1 }))).toEqual([
      { scope: undefined, model: "claude-opus-4-6", input: 40 },
    ])
    expect(observed(sdkFrame(agent, {
      type: "assistant",
      uuid: "assistant-child",
      session_id: "sdk-session-1",
      parent_tool_use_id: "tool-agent-1",
      message: { id: "req-child", model: "claude-haiku-4-5", content: [], usage: { input_tokens: 7, output_tokens: 1 } },
    }))).toEqual([{ scope: "tool-agent-1", model: "claude-haiku-4-5", input: 7 }])
    expect(observed(agent.ingest({
      source: "claude.sdk",
      method: CLAUDE_SUBAGENT_USAGE_METHOD,
      payload: { parent_tool_use_id: "tool-agent-2", session_id: "sdk-session-1", message: { id: "req-mirrored", usage: { input_tokens: 9 }, model: "claude-haiku-4-5" } } satisfies ClaudeSubagentUsage,
    }).events)).toEqual([{ scope: "tool-agent-2", model: "claude-haiku-4-5", input: 9 }])
  })

  test("a message_delta after its request stopped merges into no request", () => {
    const agent = runtime()
    for (const payload of streamedRequest("req-1", FIRST_REQUEST, 900)) sdkFrame(agent, payload)

    expect(sdkFrame(agent, messageDelta({ output_tokens: 5000 }))).toEqual([])

    const closing = sdkFrame(agent, resultFrame({}))
    expect(meteredTokens(closing)).toEqual({ input: 3, output: 900, reasoning: null, cache: { read: 1000, write: 200, write1h: 200 } })
  })
})
