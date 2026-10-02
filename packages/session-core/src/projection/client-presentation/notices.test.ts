import { describe, expect, test } from "bun:test"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { createClientPresentationProjection } from "./projection"

function turn(assistantMessageId = "msg_turn_1_r") {
  return createClientPresentationProjection({ sessionId: "session-1", directory: "/repo", assistantMessageId, clock: () => 100 })
}

function payloads(projection: ReturnType<typeof turn>, ...events: AgentRuntimeEvent[]) {
  return events.flatMap((event) => projection.ingest(event).map((envelope) => envelope.payload))
}

function parts(projection: ReturnType<typeof turn>, ...events: AgentRuntimeEvent[]) {
  return payloads(projection, ...events).flatMap((payload) => payload.type === "message.part.updated" ? [payload.properties.part] : [])
}

describe("notices the person reads", () => {
  test("a harness notice inside a turn lands in the reply as a notice part, not a diagnostic", () => {
    const projected = payloads(turn(), { type: "harness-notice", code: "claude_sdk.informational", message: "UserPromptSubmit hook blocked the prompt", severity: "warn" })
    expect(projected).toMatchObject([{
      type: "message.part.updated",
      properties: { part: { sessionID: "session-1", messageID: "msg_turn_1_r", type: "notice", time: { created: 100 },
        notice: { kind: "harness", code: "claude_sdk.informational", message: "UserPromptSubmit hook blocked the prompt", severity: "warn" } } },
    }])
  })

  test("each notice is its own part", () => {
    const projection = turn()
    const ids = parts(projection,
      { type: "harness-notice", code: "claude_sdk.notification", message: "Background task finished" },
      { type: "harness-notice", code: "claude_sdk.memory_recall", message: "Recalled from memory: /m/a.md" },
    ).map((part) => part.id)
    expect(new Set(ids).size).toBe(2)
  })

  test("a notice without a severity reads as information", () => {
    expect(parts(turn(), { type: "harness-notice", code: "claude_sdk.notification", message: "Done" })[0]).toMatchObject({ notice: { severity: "info" } })
  })

  test("a debug notice and a notice outside any turn stay diagnostics", () => {
    expect(payloads(turn(), { type: "harness-notice", code: "x", message: "trace", severity: "debug" }).map((payload) => payload.type)).toEqual(["runtime.diagnostic"])
    expect(payloads(turn(""), { type: "harness-notice", code: "acp.plugins.not-applied", message: "Not applied", severity: "warn" }).map((payload) => payload.type))
      .toEqual(["runtime.diagnostic"])
  })
})

describe("a conversation reset", () => {
  test("draws a boundary in the same session's reply", () => {
    expect(parts(turn(), { type: "conversation-reset", trigger: "clear" }))
      .toMatchObject([{ type: "notice", messageID: "msg_turn_1_r", notice: { kind: "conversation-reset", trigger: "clear" } }])
  })
})

describe("compaction", () => {
  test("one part runs from compacting to compacted", () => {
    const projection = turn()
    const started = parts(projection, { type: "session-compaction", phase: "started" })
    expect(started).toMatchObject([{ type: "notice", notice: { kind: "compaction", status: "running" } }])
    const completed = payloads(projection, { type: "session-compaction", phase: "completed", reason: "manual" })
    expect(completed).toMatchObject([
      { type: "message.part.updated", properties: { part: { id: started[0]?.id, notice: { kind: "compaction", status: "completed" } } } },
      { type: "session.compacted", properties: { sessionID: "session-1" } },
    ])
  })

  test("a failed compaction says why on the same part and announces nothing", () => {
    const projection = turn()
    const started = parts(projection, { type: "session-compaction", phase: "started" })
    const failed = payloads(projection, { type: "session-compaction", phase: "completed", metadata: { error: "prompt too long" } })
    expect(failed.map((payload) => payload.type)).toEqual(["message.part.updated"])
    expect(failed[0]).toMatchObject({ properties: { part: { id: started[0]?.id, notice: { kind: "compaction", status: "failed", error: "prompt too long" } } } })
  })

  test("a stopped compaction reads as failed and announces nothing", () => {
    const stopped = payloads(turn(), { type: "session-compaction", phase: "completed", metadata: { aborted: true } })
    expect(stopped.map((payload) => payload.type)).toEqual(["message.part.updated"])
    expect(stopped[0]).toMatchObject({ properties: { part: { notice: { kind: "compaction", status: "failed", error: "Compaction was stopped" } } } })
  })

  test("a completion with no start still draws the boundary", () => {
    expect(parts(turn(), { type: "session-compaction", phase: "completed" })).toMatchObject([{ notice: { kind: "compaction", status: "completed" } }])
  })

  test("a second compaction in the turn gets its own part", () => {
    const projection = turn()
    const first = parts(projection, { type: "session-compaction", phase: "started" }, { type: "session-compaction", phase: "completed" })
    const second = parts(projection, { type: "session-compaction", phase: "started" })
    expect(second[0]?.id).not.toBe(first[0]?.id)
  })
})
