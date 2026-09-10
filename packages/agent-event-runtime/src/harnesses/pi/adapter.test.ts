import { describe, expect, test } from "bun:test"
import { piRpcAdapter } from "./adapter"
import type { AgentRuntimeEvent } from "../../contracts/agent-runtime-event"
function translate() {
  const adapter = piRpcAdapter()
  let state = adapter.createInitialState!()
  return (payload: unknown): AgentRuntimeEvent[] => {
    const result = adapter.translate({
      state,
      event: { source: "pi.rpc", payload },
      context: { harness: "pi", threadId: "native-pi", now: () => 1, createId: () => "id" },
    })
    if (Array.isArray(result)) return result
    state = result.state ?? state
    return result.events ?? []
  }
}
describe("Pi RPC normalization", () => {
  test("assembles each content index and reconciles the final message once", () => {
    const send = translate()
    send({ type: "message_start", message: { role: "assistant" } })
    expect(
      send({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "think" },
      }),
    ).toEqual([{ type: "thinking-delta", delta: "think" }])
    send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "hel" } })
    expect(
      send({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "think" },
            { type: "text", text: "hello" },
          ],
        },
      }),
    ).toEqual([{ type: "text-delta", delta: "lo" }])
  })
  test("does not invent corrected text when the canonical final record disagrees", () => {
    const send = translate()
    send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "wrong" } })
    expect(() =>
      send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "actual" }] } }),
    ).toThrow("disagrees")
  })
  test("agent_end is not final; settled completes only once", () => {
    const send = translate()
    expect(send({ type: "agent_end" })).toEqual([])
    expect(send({ type: "agent_settled" })).toEqual([{ type: "finish", sessionId: "native-pi" }])
    expect(send({ type: "agent_settled" })).toEqual([])
  })
  test("keeps tool identity and marks provider errors", () => {
    const send = translate()
    expect(
      send({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "false" } }),
    ).toHaveLength(2)
    expect(
      send({ type: "tool_execution_end", toolCallId: "call-1", isError: true, result: "exit 1" })[0],
    ).toMatchObject({ type: "tool-error", toolCallId: "call-1" })
    expect(
      send({
        type: "message_end",
        message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Unauthorized" },
      }),
    ).toEqual([{ type: "error", error: "Unauthorized" }])
  })
})

test("Pi read result carries its image block alongside the unchanged result payload", () => {
  const send = translate()
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQ=="
  send({ type: "tool_execution_start", toolCallId: "call-image", toolName: "read", args: { path: "/repo/shot.png" } })
  const result = {
    content: [
      { type: "text", text: "Read image /repo/shot.png" },
      { type: "image", data: png, mimeType: "image/png" },
    ],
  }
  expect(send({ type: "tool_execution_end", toolCallId: "call-image", isError: false, result })).toEqual([{
    type: "tool-output",
    toolCallId: "call-image",
    output: result,
    attachments: [{ kind: "inline", mime: "image/png", url: `data:image/png;base64,${png}` }],
  }])
})

test("Pi text-only tool result stays attachment-free", () => {
  const send = translate()
  send({ type: "tool_execution_start", toolCallId: "call-text", toolName: "read", args: { path: "/repo/a.ts" } })
  const events = send({ type: "tool_execution_end", toolCallId: "call-text", isError: false, result: { content: [{ type: "text", text: "export const a = 1" }] } })
  expect(events).toEqual([{ type: "tool-output", toolCallId: "call-text", output: { content: [{ type: "text", text: "export const a = 1" }] } }])
})

test("Pi partial tool output preserves tool identity and aborted compaction reports its outcome", () => {
  const send = translate()
  expect(
    send({
      type: "tool_execution_update",
      toolCallId: "call",
      partialResult: { content: [{ type: "text", text: "progress" }] },
    }),
  ).toMatchObject([{ type: "tool-content", toolCallId: "call", content: { content: { text: "progress" } } }])
  expect(send({ type: "auto_compaction_start" })).toEqual([{ type: "session-compaction", phase: "started" }])
  expect(send({ type: "auto_compaction_end", aborted: true, errorMessage: "cancelled" })).toMatchObject([
    { type: "session-compaction", phase: "completed", metadata: { aborted: true, error: "cancelled" } },
  ])
})

test("counts observed native compaction usage without inventing unavailable categories", () => {
  const events = translate()({
    type: "compaction_end",
    result: { summary: "summary", usage: { input: 123, output: 45 } },
  })
  expect(events[0]).toMatchObject({
    type: "usage",
    observation: {
      kind: "delta",
      tokens: { input: 123, output: 45, reasoning: null, cache: { read: null, write: null } },
    },
  })
  expect(events[1]).toMatchObject({ type: "session-compaction", summary: "summary" })
})
