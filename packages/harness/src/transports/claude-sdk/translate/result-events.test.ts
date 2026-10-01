import { describe, expect, test } from "bun:test"
import { claudeRuntime as runtime } from "../test-support/runtime"

const result = (fields: Record<string, unknown>) => ({ type: "result", uuid: "result-1", session_id: "sdk-session-1", num_turns: 1, ...fields })
const tail = (events: { type: string }[]) => events.filter((event) => event.type !== "usage")

describe("claudeSdkAdapter results", () => {
  test("an interrupted turn is cancelled by its terminal reason", () => {
    expect(tail(runtime().ingest({ source: "claude.sdk.message", payload: result({ subtype: "error_during_execution", is_error: true,
      terminal_reason: "aborted_streaming", stop_reason: "tool_use",
      errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"] }) }).events))
      .toMatchObject([{ type: "session-status", status: "idle" }, { type: "cancelled", sessionId: "sdk-session-1" }])
    expect(tail(runtime().ingest({ source: "claude.sdk.message", payload: result({ subtype: "error_during_execution", is_error: true,
      terminal_reason: "aborted_tools", errors: [] }) }).events).at(-1)).toMatchObject({ type: "cancelled" })
  })

  test("a completed reply that mentions cancelling is finished", () => {
    expect(tail(runtime().ingest({ source: "claude.sdk.message", payload: result({ subtype: "success", is_error: false,
      terminal_reason: "completed", stop_reason: "end_turn", result: "Done. I cancelled the stale cron job; the interrupted build is green." }) }).events))
      .toMatchObject([{ type: "session-status", status: "idle" }, { type: "finish", sessionId: "sdk-session-1" }])
  })

  test("an error result fails the turn with the reply the SDK reports", () => {
    expect(tail(runtime().ingest({ source: "claude.sdk.message", payload: result({ subtype: "success", is_error: true,
      terminal_reason: "api_error", result: "API Error: 500 Internal server error" }) }).events))
      .toMatchObject([{ type: "session-status", status: "error" }, { type: "error", error: "API Error: 500 Internal server error" }])
  })

  test("a recoverable assistant error leaves the turn running, and a later failure carries it", () => {
    const agent = runtime()
    const assistantError = (error: string, text: string) => agent.ingest({ source: "claude.sdk.message", payload: { type: "assistant", error,
      parent_tool_use_id: null, uuid: "assistant-1", session_id: "sdk-session-1", message: { id: "msg-1", content: [{ type: "text", text }] } } }).events
    expect(assistantError("max_output_tokens", "API Error: Claude's response exceeded the output token maximum")).toEqual([])
    expect(tail(agent.ingest({ source: "claude.sdk.message", payload: result({ subtype: "success", is_error: false, terminal_reason: "completed", result: "done" }) }).events))
      .toMatchObject([{ type: "session-status", status: "idle" }, { type: "finish" }])
    const failing = runtime()
    failing.ingest({ source: "claude.sdk.message", payload: { type: "assistant", error: "rate_limit", parent_tool_use_id: null, uuid: "a", session_id: "sdk-session-1",
      message: { id: "msg-2", content: [{ type: "text", text: "API Error: Request rejected (429)" }] } } })
    expect(tail(failing.ingest({ source: "claude.sdk.message", payload: result({ subtype: "success", is_error: true, terminal_reason: "api_error",
      result: "API Error: Request rejected (429)" }) }).events)).toMatchObject([{ type: "session-status", status: "error" },
      { type: "error", error: "Claude assistant message failed: rate_limit\nAPI Error: Request rejected (429)", errorClass: "rate_limit" }])
  })
})
