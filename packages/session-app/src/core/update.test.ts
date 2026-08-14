import { describe, expect, test } from "bun:test"
import { initSessionModel, type SessionModel } from "./model"
import { applyRuntimeEvent, decodeTranscript, update } from "./update"

function model(): SessionModel {
  return initSessionModel({ sessionId: "ses_1", directory: "/tmp/project" })
}

function fold(events: Array<{ type: string } & Record<string, unknown>>, from = model()) {
  return events.reduce((m, event) => applyRuntimeEvent(m, event), from)
}

describe("runtime-event fold", () => {
  test("a full streamed turn produces user-visible rows in order", () => {
    const m = fold([
      { type: "session-status", status: "busy" },
      { type: "step-start", newMessageId: "msg_1" },
      { type: "text-delta", delta: "Hello " },
      { type: "text-delta", delta: "world" },
      { type: "tool-start", toolCallId: "t1", toolName: "bash", display: { summary: "ls -la" } },
      { type: "tool-status", toolCallId: "t1", status: "completed" },
      { type: "finish", sessionId: "ses_1" },
    ])

    expect(m.status).toBe("idle")
    expect(m.rows).toMatchObject([
      { kind: "assistant", id: "msg_1", markdown: "Hello world", streaming: false },
      { kind: "tool", toolCallId: "t1", name: "bash", status: "completed", summary: "ls -la" },
    ])
  })

  test("a delta without step-start still renders (harnesses that stream immediately)", () => {
    const m = fold([{ type: "text-delta", delta: "hi" }])
    expect(m.rows).toMatchObject([{ kind: "assistant", markdown: "hi", streaming: true }])
  })

  test("thinking and assistant streams stay separate rows", () => {
    const m = fold([
      { type: "thinking-delta", delta: "let me think" },
      { type: "step-start", newMessageId: "msg_1" },
      { type: "text-delta", delta: "answer" },
    ])
    expect(m.rows.map((row) => row.kind)).toEqual(["thinking", "assistant"])
    expect(m.rows[1]).toMatchObject({ markdown: "answer" })
  })

  test("unknown event types return the model unchanged, by reference", () => {
    const before = fold([{ type: "text-delta", delta: "x" }])
    const after = applyRuntimeEvent(before, { type: "some-future-event", payload: 1 })
    expect(after).toBe(before)
  })

  test("a text-delta preserves the identity of every untouched row", () => {
    const before = fold([
      { type: "tool-start", toolCallId: "t1", toolName: "read" },
      { type: "step-start", newMessageId: "msg_1" },
      { type: "text-delta", delta: "a" },
    ])
    const after = applyRuntimeEvent(before, { type: "text-delta", delta: "b" })
    expect(after.rows[0]).toBe(before.rows[0])
    expect(after.rows[1]).not.toBe(before.rows[1])
    expect(after.rows[1]).toMatchObject({ markdown: "ab" })
  })

  test("todo-update and plan rows are singletons replaced in place", () => {
    const m = fold([
      { type: "todo-update", todos: [{ id: "1", description: "a", status: "pending" }] },
      { type: "proposed-plan-delta", delta: "step " },
      { type: "proposed-plan-delta", delta: "one" },
      { type: "todo-update", todos: [{ id: "1", description: "a", status: "completed" }] },
      { type: "proposed-plan-complete", planMarkdown: "step one, final" },
    ])
    expect(m.rows.filter((row) => row.kind === "todos")).toHaveLength(1)
    expect(m.rows.filter((row) => row.kind === "plan")).toHaveLength(1)
    expect(m.rows.find((row) => row.kind === "plan")).toMatchObject({ markdown: "step one, final", complete: true })
  })

  test("tool errors mark the tool row failed and keep the error", () => {
    const m = fold([
      { type: "tool-start", toolCallId: "t1", toolName: "bash" },
      { type: "tool-error", toolCallId: "t1", error: "exit 1" },
    ])
    expect(m.rows[0]).toMatchObject({ kind: "tool", status: "failed", error: "exit 1" })
  })
})

describe("update", () => {
  test("submit trims, appends the user row, clears the draft, and emits the effect", () => {
    const drafted = update(model(), { type: "DraftEdited", text: "  run the tests  " }).model
    const { model: m, effects } = update(drafted, { type: "SubmitPrompt" })

    expect(m.draft).toBe("")
    expect(m.sending).toBe(true)
    expect(m.rows).toMatchObject([{ kind: "user", text: "run the tests" }])
    expect(effects).toEqual([{ kind: "send-prompt", sessionId: "ses_1", directory: "/tmp/project", text: "run the tests" }])
  })

  test("an empty or in-flight submit is a no-op", () => {
    expect(update(model(), { type: "SubmitPrompt" }).effects).toEqual([])
    const inFlight = { ...model(), draft: "x", sending: true }
    expect(update(inFlight, { type: "SubmitPrompt" }).effects).toEqual([])
  })

  test("a failed prompt surfaces as an error notice and unblocks the composer", () => {
    const sending = { ...model(), sending: true }
    const m = update(sending, { type: "PromptFailed", error: "connection refused" }).model
    expect(m.sending).toBe(false)
    expect(m.rows.at(-1)).toMatchObject({ kind: "notice", severity: "error", message: "connection refused" })
  })
})

describe("transcript decoding", () => {
  test("decodes {info, parts} records tolerantly and drops what it cannot read", () => {
    const messages = decodeTranscript([
      { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "hi" }] },
      { info: { id: "m2", role: "assistant" }, parts: [{ type: "text", text: "hello " }, { type: "text", text: "there" }, { type: "tool", weird: true }] },
      { info: { id: "m3", role: "system" }, parts: [] },
      "garbage",
      { parts: [{ type: "text", text: "no info" }] },
    ])

    expect(messages).toEqual([
      { id: "m1", role: "user", text: "hi" },
      { id: "m2", role: "assistant", text: "hello there" },
    ])
  })
})
