import { describe, expect, test } from "bun:test"
import { claudeRuntime as runtime } from "../test-support/runtime"

describe("claudeSdkAdapter", () => {
  test("maps commands changed and permission denied system messages", () => {
    const agent = runtime()

    expect(agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "system",
        subtype: "commands_changed",
        commands: [{ name: "review", description: "Review code", argumentHint: "<path>" }],
        uuid: "message-1",
        session_id: "session-1",
      },
    }).events).toMatchObject([{
      type: "available-commands-update",
      commands: [{ name: "review", description: "Review code" }],
    }])

    expect(agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "system",
        subtype: "permission_denied",
        tool_name: "Bash",
        tool_use_id: "tool-1",
        message: "Command is not allowed",
        uuid: "message-2",
        session_id: "session-1",
      },
    }).events).toMatchObject([{
      type: "tool-error",
      toolCallId: "tool-1",
      error: "Command is not allowed",
    }])
  })

  const system = (subtype: string, fields: Record<string, unknown>) =>
    ({ source: "claude.sdk.message", payload: { type: "system", subtype, uuid: `${subtype}-${String(fields.task_id)}`, session_id: "session-1", ...fields } })
  const finished = (taskId: string) => system("task_notification", { task_id: taskId, tool_use_id: `tool-${taskId}`, status: "completed", summary: `Finished ${taskId}` })

  test("a task its tool call waited on ends without a notice, because that call's result already reports it", () => {
    const agent = runtime()
    agent.ingest(system("task_started", { task_id: "fg", tool_use_id: "tool-fg", task_type: "local_bash", description: "Count lint errors", is_backgrounded: false }))
    expect(agent.ingest(finished("fg")).events).toEqual([])
  })

  test("a background task, or one moved to the background, ends with a notice", () => {
    const agent = runtime()
    agent.ingest(system("task_started", { task_id: "bg", tool_use_id: "tool-bg", task_type: "local_bash", description: "Watch the build", is_backgrounded: true }))
    agent.ingest(system("task_started", { task_id: "moved", tool_use_id: "tool-moved", task_type: "local_bash", description: "Run the suite", is_backgrounded: false }))
    agent.ingest(system("task_updated", { task_id: "moved", patch: { is_backgrounded: true } }))
    for (const id of ["bg", "moved", "unseen"]) {
      expect(agent.ingest(finished(id)).events).toMatchObject([{ type: "harness-notice", code: "claude_sdk.task_notification", message: `Finished ${id}` }])
    }
  })
})
