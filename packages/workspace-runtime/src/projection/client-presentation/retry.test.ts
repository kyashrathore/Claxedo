import { expect, test } from "bun:test"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { createClientPresentationProjection } from "./projection"

function turn() {
  return createClientPresentationProjection({ sessionId: "session-1", directory: "/repo", assistantMessageId: "msg_turn_1_r", clock: () => 1_000 })
}

function statuses(projection: ReturnType<typeof turn>, event: AgentRuntimeEvent) {
  return projection.ingest(event).flatMap(({ payload }) => (payload.type === "session.status" ? [payload.properties.status] : []))
}

test("a harness retry is the session's retry status, counting down to the next attempt", () => {
  expect(statuses(turn(), { type: "session-retry", message: "The model request failed (rate_limit, HTTP 429); retry 1 of 10", attempt: 1, delayMs: 5_000 }))
    .toEqual([{ type: "retry", message: "The model request failed (rate_limit, HTTP 429); retry 1 of 10", attempt: 1, next: 6_000 }])
})

test("a retry that reports no attempt or delay invents neither", () => {
  expect(statuses(turn(), { type: "session-retry", message: "Reconnecting... 2/5" })).toEqual([{ type: "retry", message: "Reconnecting... 2/5" }])
})

test("the reply's next content puts the session back to working, once", () => {
  const projection = turn()
  statuses(projection, { type: "session-retry", message: "Reconnecting... 2/5" })
  expect(statuses(projection, { type: "usage", contextSize: 10, contextUsed: 1 })).toEqual([])
  expect(statuses(projection, { type: "text-delta", delta: "Back" })).toEqual([{ type: "busy" }])
  expect(statuses(projection, { type: "text-delta", delta: " again" })).toEqual([])
})

test("a status or a terminal after a retry settles it without a second status", () => {
  const stopped = turn()
  statuses(stopped, { type: "session-retry", message: "Reconnecting... 2/5" })
  stopped.ingest({ type: "error", error: "gave up" })
  expect(statuses(stopped, { type: "text-delta", delta: "late" })).toEqual([])

  const reported = turn()
  statuses(reported, { type: "session-retry", message: "Reconnecting... 2/5" })
  expect(statuses(reported, { type: "session-status", status: "busy" })).toEqual([{ type: "busy" }])
  expect(statuses(reported, { type: "tool-start", toolCallId: "call-1", toolName: "bash" })).toEqual([])
})

test("content with no retry before it leaves the status alone", () => {
  expect(statuses(turn(), { type: "text-delta", delta: "Hello" })).toEqual([])
})
