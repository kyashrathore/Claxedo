import { describe, expect, test } from "bun:test"
import { claudeRuntime as runtime } from "../test-support/runtime"

const session = { uuid: "frame-1", session_id: "sdk-session-1" }
const system = (subtype: string, fields: Record<string, unknown> = {}) => ({ type: "system", subtype, ...fields, ...session })
const types = (events: { type: string }[]) => events.map((event) => event.type)

function ingest(agent: ReturnType<typeof runtime>, payload: Record<string, unknown>) {
  return agent.ingest({ source: "claude.sdk", method: `claude/${String(payload.type)}`, payload }).events
}

describe("Claude frames the pinned SDK does not declare", () => {
  test("Claude Code 2.1.285 side-channel frames are ignored by name, never an adapter error", () => {
    const agent = runtime()
    const frames = [
      system("task_summary", { detail: "Map test runners per package" }),
      system("vcs_state_changed", { kind: "rebase", cwd: "/work" }),
      system("session_title_changed", { title: "Release notes" }),
      system("thinking_tokens", { estimated_tokens: 3, estimated_tokens_delta: 3, user_message_uuid: "user-1" }),
      system("post_turn_summary", { summarizes_uuid: "u", status_category: "review_ready", status_detail: "ok", needs_action: "" }),
      { type: "stream_event", event: { type: "ping" }, parent_tool_use_id: null, ...session },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "x".repeat(512) } }, parent_tool_use_id: null, ...session },
      { type: "command_lifecycle", command_uuid: "719f94de-7ab9-4d16-a240-6c21302c46ec", state: "queued", ...session },
    ]
    for (const frame of frames) expect(ingest(agent, frame)).toEqual([])
  })

  test("init reports its commands without a diagnostic row", () => {
    expect(types(ingest(runtime(), system("init", { cwd: "/work", model: "claude-opus-5-5[1m]", tools: ["Bash"], slash_commands: ["review"], permissionMode: "default" }))))
      .toEqual(["available-commands-update"])
  })

  test("an unknown type or subtype leaves one bounded debug note per kind, without the frame", () => {
    const agent = runtime()
    const future = system("future_side_channel", { secret: "x".repeat(10_000) })
    const [note, ...rest] = ingest(agent, future)
    expect(rest).toEqual([])
    expect(note).toMatchObject({ type: "diagnostic", diagnostic: { code: "claude_sdk.ignored_frame", severity: "debug" } })
    expect(JSON.stringify(note?.type === "diagnostic" ? note.diagnostic : note)).not.toContain("xxxx")
    expect(ingest(agent, future)).toEqual([])
    expect(types(ingest(agent, { type: "future_frame", ...session }))).toEqual(["diagnostic"])
    expect(types(ingest(agent, { type: "stream_event", event: { type: "future_event" }, parent_tool_use_id: null, ...session }))).toEqual(["diagnostic"])
  })
})

describe("Claude side-channel frames the person should see", () => {
  test("an API retry is reported as a retry notice", () => {
    expect(ingest(runtime(), system("api_retry", { attempt: 1, max_retries: 10, retry_delay_ms: 591, error_status: 529, error: "overloaded" })))
      .toMatchObject([{ type: "harness-notice", code: "claude_sdk.api_retry", severity: "warn",
        message: "Claude is retrying the model request (attempt 1 of 10, overloaded 529) in 1 s" }])
  })

  test("compaction start, success and failure are compaction events", () => {
    const agent = runtime()
    expect(ingest(agent, system("status", { status: "compacting" }))).toMatchObject([
      { type: "session-status", status: "busy" }, { type: "session-compaction", phase: "started" }])
    expect(ingest(agent, system("compact_boundary", { compact_metadata: { trigger: "auto", pre_tokens: 150_000, post_tokens: 20_000 } })))
      .toMatchObject([{ type: "session-compaction", phase: "completed", reason: "auto" }])
    expect(ingest(agent, system("status", { status: null, compact_result: "failed", compact_error: "Conversation too long" })))
      .toMatchObject([{ type: "session-compaction", phase: "completed", metadata: { error: "Conversation too long" } }])
  })

  test("notifications, recalled memories, informational banners and model fallbacks are notices", () => {
    const agent = runtime()
    expect(ingest(agent, system("notification", { key: "k", text: "Background task finished", priority: "medium" })))
      .toMatchObject([{ type: "harness-notice", code: "claude_sdk.notification", message: "Background task finished" }])
    expect(ingest(agent, system("memory_recall", { mode: "select", memories: [{ path: "/m/a.md", scope: "personal" }, { path: "/m/b.md", scope: "team" }] })))
      .toMatchObject([{ type: "harness-notice", code: "claude_sdk.memory_recall", message: "Recalled from memory: /m/a.md, /m/b.md" }])
    expect(ingest(agent, system("informational", { content: "UserPromptSubmit hook blocked the prompt", level: "warning", prevent_continuation: true })))
      .toMatchObject([{ type: "harness-notice", code: "claude_sdk.informational", severity: "warn", message: "UserPromptSubmit hook blocked the prompt" }])
    expect(ingest(agent, system("model_fallback", { trigger: "overloaded", original_model: "claude-opus-5-5", fallback_model: "claude-sonnet-4-6", content: "Switched to Sonnet" })))
      .toMatchObject([{ type: "harness-notice", code: "claude_sdk.model_fallback", severity: "warn", message: "Switched to Sonnet" }])
    expect(ingest(agent, system("model_refusal_fallback", { trigger: "refusal", direction: "retry", original_model: "a", fallback_model: "b",
      request_id: null, retracted_message_uuids: ["m-1"], content: "Retried with b" })))
      .toMatchObject([{ type: "harness-notice", code: "claude_sdk.model_refusal_fallback", message: "Retried with b", details: { retractedMessageUuids: ["m-1"] } }])
    expect(ingest(agent, system("model_refusal_no_fallback", { original_model: "a", request_id: null, content: "Claude declined" })))
      .toMatchObject([{ type: "harness-notice", code: "claude_sdk.model_refusal_no_fallback", severity: "warn", message: "Claude declined" }])
  })

  test("a conversation reset after /clear is a notice", () => {
    expect(ingest(runtime(), { type: "conversation_reset", new_conversation_id: "8b3d5dd3-a512-41a3-94d8-8342f793b8d1", trigger: "clear",
      user_message_uuid: "22222222-2222-4222-8222-222222222222", timestamp: "2026-09-30T06:55:12.243Z", ...session }))
      .toMatchObject([{ type: "harness-notice", code: "claude_sdk.conversation_reset", details: { trigger: "clear" } }])
  })

  test("an authentication status error is an auth status, not a failed turn", () => {
    expect(ingest(runtime(), { type: "auth_status", isAuthenticating: false, output: [], error: "apiKeyHelper exited 1", ...session }))
      .toEqual([expect.objectContaining({ type: "auth-status", status: "unauthenticated", metadata: { error: "apiKeyHelper exited 1" } })])
  })
})
