/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { ServerEvent } from "./events"
import { placementId, projectId, sessionId } from "./ids"
import { createTurnWrites } from "./turn-writes"

const ref = { projectId: projectId("j1"), placementId: placementId("p1"), sessionId: sessionId("s1") }
const other = { ...ref, sessionId: sessionId("s2") }

const tool = (intent: string | undefined, at = ref, id = `part-${intent}`): ServerEvent => ({
  type: "partUpserted",
  ref: at,
  part: { id, sessionID: at.sessionId, messageID: "m1", type: "tool", callID: "c1", tool: id, state: { status: "running", input: intent ? { intent } : {}, time: { start: 1 } } },
})
const idle = (at = ref): ServerEvent => ({ type: "statusChanged", ref: at, status: { kind: "idle" } })

test("turn writes: a turn whose tools the runtime classed as reading ends without a file change", () => {
  const writes = createTurnWrites()
  for (const intent of ["read", "search", "list", "fetch", "todos", "question"]) expect(writes.endsWritingTurn(tool(intent))).toBe(false)
  expect(writes.endsWritingTurn(idle())).toBe(false)
})

test("turn writes: a turn that edited ends with one file change, and its second idle adds none", () => {
  const writes = createTurnWrites()
  expect(writes.endsWritingTurn(tool("edit"))).toBe(false)
  expect(writes.endsWritingTurn({ type: "statusChanged", ref, status: { kind: "working" } })).toBe(false)
  expect(writes.endsWritingTurn(idle())).toBe(true)
  expect(writes.endsWritingTurn(idle())).toBe(false)
})

test("turn writes: a shell command or a tool with no intent may write, and a failed turn still ends", () => {
  const writes = createTurnWrites()
  writes.endsWritingTurn(tool("shell"))
  expect(writes.endsWritingTurn({ type: "statusChanged", ref, status: { kind: "failed", error: { class: "internal", message: "boom", retryable: false } } })).toBe(true)
  writes.endsWritingTurn(tool(undefined))
  expect(writes.endsWritingTurn(idle())).toBe(true)
})

test("turn writes: each session's turn is its own", () => {
  const writes = createTurnWrites()
  writes.endsWritingTurn(tool("edit", other))
  expect(writes.endsWritingTurn(idle())).toBe(false)
  expect(writes.endsWritingTurn(idle(other))).toBe(true)
})

test("turn writes: a tool part counts by the intent its last update carries", () => {
  const writes = createTurnWrites()
  writes.endsWritingTurn(tool(undefined, ref, "part-1"))
  writes.endsWritingTurn(tool("read", ref, "part-1"))
  expect(writes.endsWritingTurn(idle())).toBe(false)
})
