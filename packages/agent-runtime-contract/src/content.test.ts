import { expect, test } from "bun:test"
import { isAgentContentPart, parseAgentContentPart, parseAgentMessage } from "./content"

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
