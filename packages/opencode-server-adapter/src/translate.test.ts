import { describe, expect, test } from "bun:test"
import { createClientPresentationProjection } from "@claxedo/agent-event-runtime/client-presentation"
import { OpenCodeEventTranslator, type OpenCodeLeafEvent } from "./translate"

function part(part: Record<string, unknown>): OpenCodeLeafEvent {
  return { type: "message.part.updated", properties: { part: { sessionID: "ses_1", messageID: "msg_1", id: "prt_1", ...part } } }
}

function translate(events: OpenCodeLeafEvent[]) {
  const translator = new OpenCodeEventTranslator()
  return events.flatMap((event) => translator.translate(event))
}

describe("OpenCode part translation", () => {
  for (const type of ["text", "reasoning"] as const) {
    test(`emits ${type} once across snapshot, delta and final snapshot`, () => {
      expect(translate([
        part({ type, text: "" }),
        { type: "message.part.delta", properties: { messageID: "msg_1", partID: "prt_1", field: "text", delta: "hello" } },
        part({ type, text: "hello world" }),
        part({ type, text: "hello world" }),
      ])).toEqual([
        { type: type === "text" ? "text-delta" : "thinking-delta", delta: "hello" },
        { type: type === "text" ? "text-delta" : "thinking-delta", delta: " world" },
      ])
    })
  }

  test("projects tool identity, input, metadata and completion without duplicate replay", () => {
    const running = part({ type: "tool", tool: "read", callID: "call_read", state: { status: "running", input: { filePath: "/repo/a.ts" }, metadata: { title: "a.ts" } } })
    const completed = part({ type: "tool", tool: "read", callID: "call_read", state: { status: "completed", input: { filePath: "/repo/a.ts" }, output: "contents", metadata: { preview: "contents" } } })
    const events = translate([
      part({ type: "tool", tool: "read", callID: "call_read", state: { status: "pending", input: {}, raw: "" } }),
      running, completed, completed,
    ])
    expect(events.map((event) => event.type)).toEqual(["tool-start", "tool-status", "tool-input", "tool-status", "tool-output"])
    const projection = createClientPresentationProjection({ sessionId: "local", directory: "/repo", assistantMessageId: "reply", clock: () => 100 })
    const projected = events.flatMap((event) => projection.ingest(event))
    expect(projected.at(-1)?.payload).toMatchObject({
      type: "message.part.updated",
      properties: { part: { tool: "read", callID: "call_read", state: { status: "completed", input: { filePath: "/repo/a.ts" }, output: "contents", metadata: { preview: "contents" } } } },
    })
  })

  test("a completed tool first seen during reconciliation retains its full lifecycle", () => {
    expect(translate([part({ type: "tool", tool: "bash", callID: "call_shell", state: { status: "error", input: { command: "false" }, error: "exit 1", metadata: { exit: 1 } } })]).map((event) => event.type)).toEqual(["tool-start", "tool-input", "tool-error"])
  })

  test("reports a gap instead of appending a rewritten snapshot", () => {
    expect(() => translate([part({ type: "text", text: "first" }), part({ type: "text", text: "replacement" })])).toThrow(expect.objectContaining({ code: "reconciliation_gap" }))
  })

  test("does not guess whether an orphan delta is text or reasoning", () => {
    expect(() => translate([{ type: "message.part.delta", properties: { messageID: "msg_1", partID: "prt_1", field: "text", delta: "orphan" } }])).toThrow(expect.objectContaining({ code: "reconciliation_gap" }))
  })

  test("projects the upstream retry state as canonical recovery", () => {
    expect(translate([{ type: "session.status", properties: { status: { type: "retry", attempt: 1, next: 100 } } }])).toEqual([{ type: "session-status", status: "recovering" }])
  })
})
