import { describe, expect, test } from "bun:test"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { claudeRuntime as runtime } from "../test-support/runtime"

const session = { session_id: "sdk-session-1", parent_tool_use_id: null }
let frames = 0
const stream = (event: Record<string, unknown>) => ({ type: "stream_event", event, uuid: `frame-${++frames}`, ...session })
const snapshot = (content: unknown[]) => ({ type: "assistant", message: { id: "msg_8", model: "claude-opus-5-5", content,
  usage: { input_tokens: 1, output_tokens: 1 } }, uuid: `frame-${++frames}`, ...session })

function run(frames: Record<string, unknown>[]) {
  const agent = runtime()
  return frames.flatMap((payload) => agent.ingest({ source: "claude.sdk", method: `claude/${String(payload.type)}`, payload }).events)
}

function visible(events: AgentRuntimeEvent[]) {
  return events.flatMap((event) => {
    if (event.type === "text-delta" || event.type === "thinking-delta") return [`${event.type}:${event.delta}`]
    if (event.type === "tool-start" || event.type === "tool-output" || event.type === "tool-error") return [`${event.type}:${event.toolCallId}`]
    return []
  })
}

function streamedText(index: number, text: string) {
  return [stream({ type: "content_block_start", index, content_block: { type: "text", text: "" } }),
    stream({ type: "content_block_delta", index, delta: { type: "text_delta", text } }),
    snapshot([{ type: "text", text }]),
    stream({ type: "content_block_stop", index })]
}

describe("Claude assistant blocks that share one message id", () => {
  test("two streamed text blocks of one message each appear once", () => {
    expect(visible(run([...streamedText(0, "Searching. "), ...streamedText(1, "Found it.")])))
      .toEqual(["text-delta:Searching. ", "text-delta:Found it."])
  })

  test("a snapshot-only turn keeps its reasoning, once", () => {
    expect(visible(run([snapshot([{ type: "thinking", thinking: "H1 claude reasoning", signature: "s" }]), snapshot([{ type: "text", text: "H1_CLAUDE_TEXT" }])])))
      .toEqual(["thinking-delta:H1 claude reasoning", "text-delta:H1_CLAUDE_TEXT"])
    expect(visible(run([stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
      stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "H1 claude reasoning" } }),
      snapshot([{ type: "thinking", thinking: "H1 claude reasoning", signature: "s" }])])))
      .toEqual(["thinking-delta:H1 claude reasoning"])
  })
})

describe("Claude server tools", () => {
  const advisorUse = { type: "server_tool_use", id: "srvtoolu_1", name: "advisor", input: {} }
  const advisorResult = { type: "advisor_tool_result", tool_use_id: "srvtoolu_1", content: { type: "advisor_result", text: "Looks right" } }
  const searchError = { type: "web_search_tool_result", tool_use_id: "srvtoolu_2", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } }
  const mcpResult = { type: "mcp_tool_result", tool_use_id: "mcptoolu_3", is_error: false, content: [{ type: "text", text: "3 issues" }] }

  test("a streamed server tool completes its row once", () => {
    expect(visible(run([
      stream({ type: "content_block_start", index: 0, content_block: advisorUse }), snapshot([advisorUse]), stream({ type: "content_block_stop", index: 0 }),
      stream({ type: "content_block_start", index: 1, content_block: advisorResult }), snapshot([advisorResult]), stream({ type: "content_block_stop", index: 1 }),
    ]))).toEqual(["tool-start:srvtoolu_1", "tool-output:srvtoolu_1"])
  })

  test("snapshot-only server tools start and settle, and an error result is a tool error", () => {
    const events = run([snapshot([advisorUse]), snapshot([advisorResult]),
      snapshot([{ type: "server_tool_use", id: "srvtoolu_2", name: "web_search", input: { query: "q" } }]), snapshot([searchError]),
      snapshot([{ type: "mcp_tool_use", id: "mcptoolu_3", name: "list_issues", server_name: "tracker", input: {} }]), snapshot([mcpResult])])
    expect(visible(events)).toEqual(["tool-start:srvtoolu_1", "tool-output:srvtoolu_1", "tool-start:srvtoolu_2", "tool-error:srvtoolu_2",
      "tool-start:mcptoolu_3", "tool-output:mcptoolu_3"])
    expect(events).toContainEqual(expect.objectContaining({ type: "tool-error", toolCallId: "srvtoolu_2", error: "max_uses_exceeded" }))
    expect(events).toContainEqual(expect.objectContaining({ type: "tool-output", toolCallId: "mcptoolu_3", output: "3 issues" }))
  })
})

describe("Claude tool result documents", () => {
  test("a PDF the Read tool returns travels as an attachment beside its text", () => {
    const events = run([snapshot([{ type: "tool_use", id: "toolu_pdf", name: "Read", input: { file_path: "/work/spec.pdf" } }]),
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_pdf", content: [
        { type: "text", text: "PDF file read: /work/spec.pdf (12 bytes)" },
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQK" } }] }] }, ...session }])
    expect(events).toContainEqual(expect.objectContaining({ type: "tool-output", toolCallId: "toolu_pdf", output: "PDF file read: /work/spec.pdf (12 bytes)",
      attachments: [{ kind: "inline", mime: "application/pdf", url: "data:application/pdf;base64,JVBERi0xLjQK", filename: "spec.pdf" }] }))
  })
})
