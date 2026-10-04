import { describe, expect, test } from "bun:test"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { claudeTranslator } from "../events"
import { CLAUDE_SUBAGENT_USAGE_METHOD } from "./request-stream"
import { createClaudeTaskLedger, createClaudeTranslatorMemory } from "."
import { claudeRuntime as runtime } from "../test-support/runtime"

type Runtime = { ingest(event: { source: string; method?: string; payload: unknown }): { events: AgentRuntimeEvent[] } }

const OPUS = "claude-opus-5-5"
const init = { type: "system", subtype: "init", cwd: "/work", model: `${OPUS}[1m]`, tools: [], slash_commands: [], uuid: "i", session_id: "s" }
const frame = (runtime: Runtime, payload: Record<string, unknown>) =>
  runtime.ingest({ source: "claude.sdk", method: `claude/${String(payload.type)}`, payload }).events
const request = (id: string, usage: Record<string, number>, owner: string | null = null, model = OPUS) => ({ type: "assistant",
  parent_tool_use_id: owner, uuid: `a-${id}`, session_id: "s", message: { id, model, content: [], usage } })
const mirrored = (runtime: Runtime, id: string, usage: Record<string, number>) => runtime.ingest({ source: "claude.sdk",
  method: CLAUDE_SUBAGENT_USAGE_METHOD, payload: { parent_tool_use_id: null, subpath: "subagents/agent-a1", session_id: "s", message: { id, usage, model: OPUS } } }).events
const usage = (events: AgentRuntimeEvent[]) => events.flatMap((event) => event.type === "usage" ? [event] : [])
const total = (event: AgentRuntimeEvent | undefined) => event?.type === "usage" && event.observation
  ? (event.observation.tokens.input ?? 0) + (event.observation.tokens.output ?? 0) + (event.observation.tokens.cache.read ?? 0) : undefined
const result = (modelUsage: Record<string, unknown>) => ({ type: "result", subtype: "success", is_error: false, terminal_reason: "completed",
  uuid: "r", session_id: "s", usage: {}, modelUsage })

describe("Claude usage attribution", () => {
  test("a subagent request streamed to its child is not metered again from the transcript mirror", () => {
    const agent = runtime()
    frame(agent, request("req-parent", { input_tokens: 10, output_tokens: 5 }))
    expect(usage(frame(agent, request("req-child", { input_tokens: 33_049, output_tokens: 8 }, "toolu_agent")))).toHaveLength(1)
    expect(mirrored(agent, "req-child", { input_tokens: 33_049, output_tokens: 8 })).toEqual([])
    expect(mirrored(agent, "req-child", { input_tokens: 33_049, output_tokens: 310 })).toEqual([])
    const unseen = usage(mirrored(agent, "req-only-mirrored", { input_tokens: 500, output_tokens: 7 }))
    expect(unseen).toMatchObject([{ observation: { scope: "subagents/agent-a1", tokens: { input: 500, output: 7 } } }])
    expect(unseen[0]?.contextUsed).toBe(15)
  })

  test("a child's running total continues across the parent's turns on one process", () => {
    const memory = createClaudeTranslatorMemory()
    const tasks = createClaudeTaskLedger()
    const first = claudeTranslator("turn-1", [], tasks, memory).runtime
    const opened = usage(frame(first, request("req-c1", { input_tokens: 1_000_000, output_tokens: 90_000 }, "toolu_agent")))
    expect(total(opened.at(-1))).toBe(1_090_000)
    const second = claudeTranslator("turn-2", [], tasks, memory).runtime
    const continued = usage(frame(second, request("req-c2", { input_tokens: 82_000, output_tokens: 100 }, "toolu_agent")))
    expect(total(continued.at(-1))).toBe(1_172_100)
  })
})

describe("Claude context meter", () => {
  test("an unknown context window reads as unknown, never as a full context", () => {
    const [event] = usage(frame(runtime(), request("req-1", { input_tokens: 4, cache_read_input_tokens: 40_000, output_tokens: 3 })))
    expect(event).toMatchObject({ contextSize: 0, contextUsed: 40_007 })
  })

  test("the window comes from the main model's entry and holds for the process's later turns", () => {
    const memory = createClaudeTranslatorMemory()
    const tasks = createClaudeTaskLedger()
    const first = claudeTranslator("turn-1", [], tasks, memory).runtime
    frame(first, init)
    frame(first, request("req-1", { input_tokens: 4, cache_read_input_tokens: 400_000, output_tokens: 3 }))
    const closing = usage(frame(first, result({ "claude-haiku-4-5": { contextWindow: 200_000, canonicalModel: "claude-haiku-4-5" },
      [`${OPUS}[1m]`]: { contextWindow: 1_000_000, canonicalModel: OPUS } })))
    expect(closing).toMatchObject([{ contextSize: 1_000_000, contextUsed: 400_007 }])
    const second = claudeTranslator("turn-2", [], tasks, memory).runtime
    frame(second, init)
    expect(usage(frame(second, request("req-2", { input_tokens: 5, cache_read_input_tokens: 410_000, output_tokens: 1 }))))
      .toMatchObject([{ contextSize: 1_000_000, contextUsed: 410_006 }])
  })
})
