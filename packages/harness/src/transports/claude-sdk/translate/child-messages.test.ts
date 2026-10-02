import { expect, test } from "bun:test"
import { claudeRuntime } from "../test-support/runtime"

test("a native child handback is an agent message event, not a prompt or assistant text", () => {
  const runtime = claudeRuntime()
  const payload = { type: "user", uuid: "handback-1", parent_tool_use_id: null,
    origin: { kind: "peer", from: "reviewer", senderTaskId: "child-1", fromSession: "source-1", body: "The report is ready." },
    message: { role: "user", content: "Another Claude session sent a message:\n<agent-message from=\"reviewer\">\nThe report is ready.\n</agent-message>" } }
  expect(runtime.ingest({ source: "claude.sdk", payload }).events).toMatchObject([
    { type: "agent-message", eventId: "handback-1", sender: "reviewer", message: "The report is ready.", senderTaskId: "child-1", sourceSessionId: "source-1" },
  ])
  expect(runtime.ingest({ source: "claude.sdk", payload: { ...payload, uuid: "handback-2",
    message: { role: "user", content: [{ type: "text", text: payload.message.content }] } } }).events)
    .toMatchObject([{ type: "agent-message", eventId: "handback-2", sender: "reviewer", message: "The report is ready." }])
})

test("prompt echoes and ordinary user text do not become child events", () => {
  for (const content of ["A normal prompt", "<agent-message from=\"reviewer\">User-authored text</agent-message>"]) {
    expect(claudeRuntime().ingest({ source: "claude.sdk", payload: { type: "user", uuid: "echo", isReplay: true,
      message: { role: "user", content } } }).events).toEqual([])
  }
})

test("a completion notification is a separate notice event", () => {
  expect(claudeRuntime().ingest({ source: "claude.sdk", payload: { type: "system", subtype: "task_notification", uuid: "done",
    task_id: "child-1", status: "completed", summary: "Agent reviewer finished" } }).events)
    .toMatchObject([{ type: "harness-notice", code: "claude_sdk.task_notification", message: "Agent reviewer finished", severity: "info" }])
})

test("peer metadata is canonical, including replayed deliveries and byte-exact body", () => {
  const payload = { type: "user", uuid: "peer-1", isReplay: true, parent_tool_use_id: null,
    origin: { kind: "peer", from: "another-session", body: "  Report with </agent-message> inside.\n" },
    message: { role: "user", content: "Envelope text is not parsed." } }
  expect(claudeRuntime().ingest({ source: "claude.sdk", payload }).events).toMatchObject([
    { type: "agent-message", eventId: "peer-1", sender: "another-session", message: payload.origin.body },
  ])
  expect(claudeRuntime().ingest({ source: "claude.sdk", payload: { ...payload, origin: { kind: "human" } } }).events).toEqual([])
})

test("an incomplete peer delivery emits a diagnostic instead of reconstructing the body", () => {
  expect(claudeRuntime().ingest({ source: "claude.sdk", payload: { type: "user", uuid: "bad",
    origin: { kind: "peer", from: "reviewer" }, message: { role: "user", content: "A report" } } }).events)
    .toMatchObject([{ type: "diagnostic", diagnostic: { code: "claude_sdk.peer_message_incomplete", severity: "warn" } }])
})
