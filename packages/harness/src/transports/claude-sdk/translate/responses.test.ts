import { describe, expect, test } from "bun:test"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { claudeRuntime as runtime } from "../test-support/runtime"

const session = { session_id: "sdk-session-1" }

function frame(agent: ReturnType<typeof runtime>, payload: Record<string, unknown>) {
  return agent.ingest({ source: "claude.sdk", method: `claude/${String(payload.type)}`, payload }).events
}

function stream(event: Record<string, unknown>, owner: string | null = null) {
  return { type: "stream_event", uuid: `stream-${String(event.type)}`, parent_tool_use_id: owner, event, ...session }
}

function messageStart(id: string, owner: string | null = null) {
  return stream({ type: "message_start", message: { id, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], usage: { input_tokens: 1, output_tokens: 1 } } }, owner)
}

function stop(reason: string) {
  return stream({ type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 2 } })
}

function assistant(uuid: string, id: string, text: string, extra: Record<string, unknown> = {}) {
  return { type: "assistant", uuid, parent_tool_use_id: null, message: { id, type: "message", role: "assistant", model: "claude-opus-5-5",
    content: [{ type: "text", text }], usage: { input_tokens: 1, output_tokens: 2 } }, ...extra, ...session }
}

function refusalFallback(uuids: string[]) {
  return { type: "system", subtype: "model_refusal_fallback", trigger: "refusal", direction: "retry", original_model: "claude-opus-5-5",
    fallback_model: "claude-sonnet-4-6", request_id: "req_1", retracted_message_uuids: uuids, content: "Opus refused; Sonnet answered instead",
    uuid: "fallback-notice", ...session }
}

const of = (events: AgentRuntimeEvent[], type: AgentRuntimeEvent["type"]) => events.filter((event) => event.type === type)

describe("Claude's model responses", () => {
  test("each model response starts once, from its stream or from its first frame when nothing streamed", () => {
    const agent = runtime()
    expect(of(frame(agent, messageStart("msg_1")), "response-start")).toMatchObject([{ responseId: "msg_1" }])
    expect(of(frame(agent, assistant("frame-1", "msg_1", "Hello")), "response-start")).toEqual([])
    expect(of(frame(agent, assistant("frame-2", "msg_2", "Again")), "response-start")).toMatchObject([{ responseId: "msg_2" }])
  })

  test("a subagent's responses start under its own stream", () => {
    const agent = runtime()
    expect(of(frame(agent, messageStart("msg_child", "call-1")), "response-start")).toMatchObject([{ responseId: "msg_child" }])
    expect(of(frame(agent, messageStart("msg_main")), "response-start")).toMatchObject([{ responseId: "msg_main" }])
  })
})

describe("a refusal fallback retracts the refused response by identity", () => {
  function refusedThenReplaced(agent: ReturnType<typeof runtime>) {
    frame(agent, messageStart("msg_refused"))
    frame(agent, stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }))
    frame(agent, stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Partial ans" } }))
    frame(agent, assistant("frame-refused", "msg_refused", "Partial ans"))
    frame(agent, stop("refusal"))
    frame(agent, messageStart("msg_fallback"))
  }

  test("the replacement's supersedes names the refused frames, and the end-of-turn notice names them again", () => {
    const agent = runtime()
    refusedThenReplaced(agent)
    const replacement = frame(agent, assistant("frame-fallback", "msg_fallback", "Real answer", { supersedes: ["frame-refused"] }))
    expect(of(replacement, "response-retracted")).toMatchObject([{ responseIds: ["msg_refused"], reason: "refusal" }])
    const notice = frame(agent, refusalFallback(["frame-refused"]))
    expect(of(notice, "response-retracted")).toMatchObject([{ responseIds: ["msg_refused"], reason: "refusal" }])
    expect(of(notice, "harness-notice")).toMatchObject([{ code: "claude_sdk.model_refusal_fallback", message: "Opus refused; Sonnet answered instead" }])
    expect(of(notice, "diagnostic")).toEqual([])
  })

  test("uuids the translator never saw fall back to the response whose stream stopped on the refusal, with a diagnostic", () => {
    const agent = runtime()
    frame(agent, messageStart("msg_refused"))
    frame(agent, stop("refusal"))
    const notice = frame(agent, refusalFallback(["frame-never-seen"]))
    expect(of(notice, "response-retracted")).toMatchObject([{ responseIds: ["msg_refused"], reason: "refusal" }])
    expect(of(notice, "diagnostic")).toMatchObject([{ diagnostic: { code: "claude_sdk.retraction_unmapped", severity: "warn" } }])
  })

  test("with nothing to name, nothing is retracted and the diagnostic says so", () => {
    const notice = frame(runtime(), refusalFallback(["frame-never-seen"]))
    expect(of(notice, "response-retracted")).toEqual([])
    expect(of(notice, "diagnostic")).toMatchObject([{ diagnostic: { code: "claude_sdk.retraction_unmapped" } }])
    expect(of(notice, "harness-notice")).toHaveLength(1)
  })

  test("a refusal with no fallback retracts nothing: Claude keeps the partial answer", () => {
    const agent = runtime()
    frame(agent, messageStart("msg_refused"))
    frame(agent, stop("refusal"))
    const declined = frame(agent, { type: "system", subtype: "model_refusal_no_fallback", original_model: "claude-opus-5-5", request_id: null,
      content: "Claude declined", uuid: "declined", ...session })
    expect(of(declined, "response-retracted")).toEqual([])
    expect(of(declined, "harness-notice")).toHaveLength(1)
  })
})
