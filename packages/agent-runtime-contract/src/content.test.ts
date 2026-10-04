import { expect, test } from "bun:test"
import { isAgentContentPart, isAgentSnapshotFileDiff, isAgentTodo, parseAgentContentPart, parseAgentMessage } from "./content"

const identity = { id: "prt_1", sessionID: "ses_1", messageID: "msg_1" }

test("a part is rejected when it lacks the identity every part declares", () => {
  expect(parseAgentContentPart({ type: "text", text: "hi" })).toBeUndefined()
  expect(parseAgentContentPart({ ...identity, type: "text", text: 7 })).toBeUndefined()
  expect(parseAgentContentPart(null)).toBeUndefined()
  expect(parseAgentContentPart([{ ...identity, type: "text", text: "hi" }])).toBeUndefined()
})

test("a part is rejected when its `type` is outside the union", () => {
  expect(parseAgentContentPart({ ...identity, type: "telemetry", value: 1 })).toBeUndefined()
})

test("a recognized part passes through unchanged, undeclared fields included", () => {
  const part = { ...identity, type: "text" as const, text: "hi", vendorExtra: { seq: 3 } }
  expect(parseAgentContentPart(part)).toBe(part)
})

test("each variant is checked against the fields it declares", () => {
  expect(isAgentContentPart({ ...identity, type: "reasoning", text: "why", time: { start: 1 } })).toBe(true)
  // `reasoning` declares `time` as required, unlike `text`.
  expect(isAgentContentPart({ ...identity, type: "reasoning", text: "why" })).toBe(false)

  expect(isAgentContentPart({ ...identity, type: "tool", callID: "c", tool: "bash", state: { status: "pending", input: {}, raw: "{}" } })).toBe(true)
  expect(isAgentContentPart({ ...identity, type: "tool", callID: "c", tool: "bash", state: { status: "pending", input: {} } })).toBe(false)
  expect(isAgentContentPart({ ...identity, type: "tool", callID: "c", tool: "bash", state: { status: "invented", input: {} } })).toBe(false)

  const tokens = { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }
  expect(isAgentContentPart({ ...identity, type: "step-finish", reason: "stop", cost: 0.1, tokens })).toBe(true)
  expect(isAgentContentPart({ ...identity, type: "step-finish", reason: "stop", cost: 0.1, tokens: { ...tokens, cache: {} } })).toBe(false)

  expect(isAgentContentPart({ ...identity, type: "patch", hash: "abc", files: ["a.ts"] })).toBe(true)
  expect(isAgentContentPart({ ...identity, type: "patch", hash: "abc", files: [1] })).toBe(false)

  expect(isAgentContentPart({ ...identity, type: "step-start" })).toBe(true)
  expect(isAgentContentPart({ ...identity, type: "compaction", auto: true })).toBe(true)
  expect(isAgentContentPart({ ...identity, type: "compaction", auto: "yes" })).toBe(false)
})

test("retracted text and reasoning keep their content and say why", () => {
  expect(isAgentContentPart({ ...identity, type: "text", text: "Partial", retracted: { reason: "refusal" } })).toBe(true)
  expect(isAgentContentPart({ ...identity, type: "reasoning", text: "Partial", time: { start: 1 }, retracted: { reason: "refusal" } })).toBe(true)
  expect(isAgentContentPart({ ...identity, type: "text", text: "Partial", retracted: true })).toBe(false)
})

test("a notice part carries one of the notices the transcript draws", () => {
  const notice = { ...identity, type: "notice" as const, time: { created: 1 } }
  expect(isAgentContentPart({ ...notice, notice: { kind: "harness", code: "claude_sdk.notification", message: "Done", severity: "info" } })).toBe(true)
  expect(isAgentContentPart({ ...notice, notice: { kind: "harness", code: "c", message: "m", severity: "debug" } })).toBe(false)
  expect(isAgentContentPart({ ...notice, notice: { kind: "compaction", status: "running" } })).toBe(true)
  expect(isAgentContentPart({ ...notice, notice: { kind: "compaction", status: "failed", error: "too long" } })).toBe(true)
  expect(isAgentContentPart({ ...notice, notice: { kind: "compaction", status: "failed" } })).toBe(false)
  expect(isAgentContentPart({ ...notice, notice: { kind: "conversation-reset", trigger: "clear" } })).toBe(true)
  expect(isAgentContentPart({ ...notice, notice: { kind: "conversation-reset" } })).toBe(false)
  expect(isAgentContentPart({ ...notice, notice: { kind: "invented" } })).toBe(false)
  expect(isAgentContentPart({ ...notice, time: undefined, notice: { kind: "compaction", status: "completed" } })).toBe(false)
})

test("a file part's url is a renderable reference, not an arbitrary scheme", () => {
  const file = { ...identity, type: "file" as const, mime: "image/png" }
  for (const url of ["", "docs/shot.webp", "data:image/png;base64,iVBOR", "file:///tmp/huge.png", "https://files.example/shot.png"]) {
    expect(isAgentContentPart({ ...file, url })).toBe(true)
  }
  for (const url of ["javascript:alert(1)", "  javascript:alert(1)", "java\tscript:alert(1)", "vbscript:msgbox(1)"]) {
    expect(isAgentContentPart({ ...file, url })).toBe(false)
  }
  expect(isAgentContentPart({ ...file, url: 7 })).toBe(false)
})

test("a completed tool's attachments are themselves file parts", () => {
  const state = {
    status: "completed",
    input: {},
    output: "done",
    title: "read",
    metadata: {},
    time: { start: 1, end: 2 },
  }
  const tool = { ...identity, type: "tool" as const, callID: "c", tool: "read" }
  const attachment = { ...identity, type: "file", mime: "image/png", url: "data:image/png;base64,iVBOR" }
  expect(isAgentContentPart({ ...tool, state: { ...state, attachments: [attachment] } })).toBe(true)
  expect(isAgentContentPart({ ...tool, state: { ...state, attachments: [{}] } })).toBe(false)
  expect(isAgentContentPart({ ...tool, state: { ...state, attachments: [{ ...attachment, url: "javascript:alert(1)" }] } })).toBe(false)
  expect(isAgentContentPart({ ...tool, state: { ...state, attachments: "not-a-list" } })).toBe(false)
})

test("a message needs a header and parts the contract describes", () => {
  const info = { id: "msg_1", role: "assistant", sessionID: "ses_1" }
  const parts = [{ ...identity, type: "text" as const, text: "hi" }]
  expect(parseAgentMessage({ info, parts })).toEqual({ info, parts })
  expect(parseAgentMessage({ info: { ...info, role: 7 }, parts })).toBeUndefined()
  expect(parseAgentMessage({ info, parts: [{ ...identity, type: "telemetry" }] })).toBeUndefined()
  expect(parseAgentMessage({ info, parts: {} })).toBeUndefined()
  expect(parseAgentMessage({ parts })).toBeUndefined()
})

test("optional header fields are checked only when present", () => {
  const info = { id: "msg_1", role: "assistant", sessionID: "ses_1" }
  expect(parseAgentMessage({ info: { ...info, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [] })).toBeDefined()
  expect(parseAgentMessage({ info: { ...info, tokens: { input: 1 } }, parts: [] })).toBeUndefined()
  expect(parseAgentMessage({ info: { ...info, error: { name: "Boom", data: {} } }, parts: [] })).toBeDefined()
  expect(parseAgentMessage({ info: { ...info, error: "Boom" }, parts: [] })).toBeUndefined()
})

test("a todo needs its content, status and priority, and an id only when present", () => {
  const todo = { content: "write the parser", status: "pending", priority: "medium" }
  expect(isAgentTodo(todo)).toBe(true)
  expect(isAgentTodo({ ...todo, id: "task_1" })).toBe(true)
  expect(isAgentTodo({ ...todo, id: 1 })).toBe(false)
  expect(isAgentTodo({ content: "write the parser", status: "pending" })).toBe(false)
  expect(isAgentTodo(null)).toBe(false)
})

test("a diff summary entry needs its counts and a known status when it names one", () => {
  const diff = { file: "main.ts", additions: 1, deletions: 0 }
  expect(isAgentSnapshotFileDiff(diff)).toBe(true)
  expect(isAgentSnapshotFileDiff({ additions: 1, deletions: 0 })).toBe(true)
  expect(isAgentSnapshotFileDiff({ ...diff, status: "renamed" })).toBe(false)
  expect(isAgentSnapshotFileDiff({ ...diff, patch: {} })).toBe(false)
  expect(isAgentSnapshotFileDiff({ file: "main.ts", additions: "1", deletions: 0 })).toBe(false)
})
