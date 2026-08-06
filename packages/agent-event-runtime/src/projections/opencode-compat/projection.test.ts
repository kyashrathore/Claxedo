import { describe, expect, test } from "bun:test"
import { createOpencodeCompatProjection } from "./projection"

function makeProjection() {
  return createOpencodeCompatProjection({
    sessionId: "session-1",
    directory: "/repo",
    assistantMessageId: "assistant-1",
    clock: () => 100,
  })
}

describe("createOpencodeCompatProjection", () => {
  test("emits text deltas incrementally", () => {
    const projection = createOpencodeCompatProjection({
      sessionId: "session-1",
      directory: "/repo",
      assistantMessageId: "assistant-1",
    })

    expect(projection.ingest({ type: "text-delta", delta: "hel" }).map((event) => event.payload.type)).toEqual([
      "message.part.updated",
      "message.part.delta",
    ])
    expect(projection.ingest({ type: "text-delta", delta: "lo" }).map((event) => event.payload.type)).toEqual([
      "message.part.delta",
    ])
    expect(projection.snapshot().state.accumulatedText).toBe("hello")
  })

  test("resumes from a snapshot without duplicating part ids", () => {
    const first = createOpencodeCompatProjection({
      sessionId: "session-1",
      directory: "/repo",
      assistantMessageId: "assistant-1",
    })
    first.ingest({ type: "text-delta", delta: "hello" })

    const next = createOpencodeCompatProjection({
      sessionId: "session-1",
      directory: "/repo",
      assistantMessageId: "assistant-1",
      initialSnapshot: first.snapshot(),
    })

    expect(next.ingest({ type: "text-delta", delta: "!" })).toEqual([{
      directory: "/repo",
      payload: {
        id: "message.part.delta:assistant-1:000000_assistant-1-text",
        type: "message.part.delta",
        properties: {
          sessionID: "session-1",
          messageID: "assistant-1",
          partID: "000000_assistant-1-text",
          field: "text",
          delta: "!",
        },
      },
    }])
  })

  test("restores the current assistant message id after a step-start snapshot", () => {
    const first = makeProjection()
    first.ingest({ type: "step-start", newMessageId: "assistant-2" })

    const next = createOpencodeCompatProjection({
      sessionId: "session-1",
      directory: "/repo",
      assistantMessageId: "assistant-1",
      initialSnapshot: first.snapshot(),
      clock: () => 100,
    })

    expect(next.ingest({ type: "text-delta", delta: "after reload" })[0]?.payload).toMatchObject({
      type: "message.part.updated",
      properties: {
        part: {
          sessionID: "session-1",
          messageID: "assistant-2",
          type: "text",
          text: "",
        },
      },
    })
  })

  test("uses the injected clock for session title timestamps", () => {
    const projection = makeProjection()

    expect(projection.ingest({ type: "session-title", title: "Runtime work" })[0]?.payload).toMatchObject({
      type: "session.updated",
      properties: {
        info: {
          title: "Runtime work",
          time: { created: 100, updated: 100 },
        },
      },
    })
  })

  test("projects runtime diagnostics into persisted compat events", () => {
    const projection = makeProjection()

    expect(projection.ingest({
      type: "diagnostic",
      harness: "codex-acp",
      threadId: "thread-1",
      diagnostic: {
        code: "runtime.adapter_error",
        message: "bad frame",
        severity: "error",
        source: "acp.jsonrpc",
        method: "session/update",
      },
      raw: { source: "acp.jsonrpc", method: "session/update", payload: { bad: true } },
    })[0]?.payload).toMatchObject({
      type: "runtime.diagnostic",
      properties: {
        sessionID: "session-1",
        harness: "codex-acp",
        threadId: "thread-1",
        code: "runtime.adapter_error",
        message: "bad frame",
        severity: "error",
      },
    })
  })

  test("projects session harness surfaces into compat diagnostics and status", () => {
    const projection = makeProjection()

    expect(projection.ingest({ type: "session-compaction", phase: "completed" })[0]?.payload).toMatchObject({
      type: "session.compacted",
      properties: {
        sessionID: "session-1",
      },
    })

    expect(projection.ingest({
      type: "harness-notice",
      code: "codex_app_server.warning",
      message: "Careful",
      severity: "warn",
    })[0]?.payload).toMatchObject({
      type: "runtime.diagnostic",
      properties: {
        sessionID: "session-1",
        code: "codex_app_server.warning",
        message: "Careful",
        severity: "warn",
      },
    })

    expect(projection.ingest({
      type: "rate-limit",
      status: "limited",
      usedPercent: 95,
      reason: "rate_limit_reached",
    })[0]?.payload).toMatchObject({
      type: "runtime.diagnostic",
      properties: {
        sessionID: "session-1",
        code: "runtime.rate_limit",
        severity: "warn",
        rateLimit: {
          status: "limited",
          usedPercent: 95,
          reason: "rate_limit_reached",
        },
      },
    })
  })

  test("projects proposed plans as visible text compat events", () => {
    const projection = makeProjection()

    expect(projection.ingest({ type: "proposed-plan-delta", delta: "## Plan\n" }).map((event) => event.payload.type)).toEqual([
      "message.part.updated",
      "message.part.delta",
    ])
    expect(projection.ingest({ type: "proposed-plan-complete", planMarkdown: "## Plan\n- inspect" })).toEqual([{
      directory: "/repo",
      payload: {
        id: "message.part.delta:assistant-1:000000_assistant-1-text",
        type: "message.part.delta",
        properties: {
          sessionID: "session-1",
          messageID: "assistant-1",
          partID: "000000_assistant-1-text",
          field: "text",
          delta: "- inspect",
        },
      },
    }])
  })

  test("projects tool lifecycle updates", () => {
    const projection = makeProjection()

    projection.ingest({ type: "tool-start", toolCallId: "tool-1", toolName: "bash" })
    projection.ingest({ type: "tool-input", toolCallId: "tool-1", input: { command: "pwd" } })
    const completed = projection.ingest({ type: "tool-output", toolCallId: "tool-1", output: { stdout: "/repo" } })

    expect(completed[0]?.payload).toMatchObject({
      type: "message.part.updated",
      properties: {
        part: {
          id: "000000_tool-1",
          type: "tool",
          callID: "tool-1",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "pwd" },
            output: "/repo",
          },
        },
      },
    })
  })

  test("flattens array-shaped tool output content", () => {
    const projection = makeProjection()

    projection.ingest({ type: "tool-start", toolCallId: "tool-1", toolName: "task" })
    const completed = projection.ingest({
      type: "tool-output",
      toolCallId: "tool-1",
      output: { content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] },
    })

    expect(completed[0]?.payload).toMatchObject({
      type: "message.part.updated",
      properties: { part: { state: { status: "completed", output: "first\nsecond" } } },
    })
  })

  test("sanitizes unserializable tool output and emits a projection diagnostic", () => {
    const projection = makeProjection()
    const circular: Record<string, unknown> = { ok: true, count: 1n }
    circular.self = circular

    projection.ingest({ type: "tool-start", toolCallId: "tool-1", toolName: "bash" })
    const events = projection.ingest({ type: "tool-output", toolCallId: "tool-1", output: circular })

    expect(events.map((event) => event.payload.type)).toEqual([
      "runtime.diagnostic",
      "message.part.updated",
    ])
    expect(events[0]?.payload).toMatchObject({
      type: "runtime.diagnostic",
      properties: {
        sessionID: "session-1",
        projection: "opencode-compat",
        phase: "ingest",
        code: "projection.opencode_compat.unserializable_output",
        eventType: "tool-output",
        issues: ["bigint", "circular"],
      },
    })
    expect(events[1]?.payload).toMatchObject({
      type: "message.part.updated",
      properties: {
        part: {
          state: {
            status: "completed",
            output: "{\"ok\":true,\"count\":\"1\",\"self\":\"[Circular]\"}",
          },
        },
      },
    })
    expect(projection.snapshot().state.toolStatusByCallId["tool-1"]).toBe("completed")
  })

  test("keeps out-of-order completed tools terminal when metadata arrives later", () => {
    const projection = makeProjection()

    const completed = projection.ingest({ type: "tool-output", toolCallId: "tool-1", output: "done" })
    const metadata = projection.ingest({ type: "tool-start", toolCallId: "tool-1", toolName: "bash" })

    expect(completed[0]?.payload).toMatchObject({
      type: "message.part.updated",
      properties: {
        part: {
          tool: "tool-1",
          state: {
            status: "completed",
            output: "done",
          },
        },
      },
    })
    expect(metadata.map((event) => event.payload.type)).toEqual([
      "runtime.diagnostic",
      "message.part.updated",
    ])
    expect(metadata[1]?.payload).toMatchObject({
      properties: {
        part: {
          tool: "bash",
          state: {
            status: "completed",
            output: "done",
          },
        },
      },
    })
    expect(projection.snapshot().state.toolStatusByCallId["tool-1"]).toBe("completed")
  })

  test("diagnoses duplicate terminal tool updates without emitting repeated tool cards", () => {
    const projection = makeProjection()

    projection.ingest({ type: "tool-start", toolCallId: "tool-1", toolName: "bash" })
    projection.ingest({ type: "tool-output", toolCallId: "tool-1", output: "done" })
    const duplicate = projection.ingest({ type: "tool-output", toolCallId: "tool-1", output: "done again" })

    expect(duplicate).toHaveLength(1)
    expect(duplicate[0]?.payload).toMatchObject({
      type: "runtime.diagnostic",
      properties: {
        code: "projection.opencode_compat.duplicate_terminal_tool_update",
        eventType: "tool-output",
      },
    })
    expect(projection.snapshot().state.toolOutputsByCallId["tool-1"]).toBe("done")
  })

  test("terminalization sanitizes non-json-safe tool metadata", () => {
    const projection = makeProjection()

    projection.ingest({
      type: "tool-start",
      toolCallId: "tool-1",
      toolName: "bash",
      metadata: { acp: { count: 1n } },
    })
    const events = projection.terminalizeOpenTools("prompt failed")

    expect(events.map((event) => event.payload.type)).toEqual([
      "runtime.diagnostic",
      "message.part.updated",
    ])
    expect(events[0]?.payload).toMatchObject({
      type: "runtime.diagnostic",
      properties: {
        code: "projection.opencode_compat.sanitized_event",
        phase: "terminalize",
        issues: ["bigint"],
      },
    })
    expect(events[1]?.payload).toMatchObject({
      properties: {
        part: {
          state: {
            status: "error",
            metadata: { acp: { count: "1" } },
          },
        },
      },
    })
    expect(projection.snapshot().state.toolStatusByCallId["tool-1"]).toBe("error")
  })

  test("rolls back state when projection translation throws", () => {
    const projection = makeProjection()
    const before = projection.snapshot()

    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    const events = projection.ingest({
      type: "text-delta",
      get delta() {
        throw new Error("bad delta")
      },
    } as never)

    expect(events[0]?.payload).toMatchObject({
      type: "runtime.diagnostic",
      properties: {
        code: "projection.opencode_compat.error",
        phase: "ingest",
        eventType: "text-delta",
        message: "bad delta",
      },
    })
    expect(projection.snapshot()).toEqual(before)
    expect(projection.ingest({ type: "text-delta", delta: "ok" })[0]?.payload).toMatchObject({
      type: "message.part.updated",
      properties: {
        part: {
          text: "",
        },
      },
    })
  })

  test("returns projection snapshots that do not mutate after later tool updates", () => {
    const projection = makeProjection()
    projection.ingest({ type: "tool-start", toolCallId: "tool-1", toolName: "bash" })

    const snapshot = projection.snapshot()
    projection.ingest({ type: "tool-output", toolCallId: "tool-1", output: { stdout: "done" } })

    expect(snapshot.state.toolStatusByCallId["tool-1"]).toBe("running")
  })

  test("clones restored projection snapshots so projections are independent", () => {
    const original = makeProjection()
    original.ingest({ type: "tool-start", toolCallId: "tool-1", toolName: "bash" })
    const snapshot = original.snapshot()
    const first = createOpencodeCompatProjection({
      sessionId: "session-1",
      directory: "/repo",
      assistantMessageId: "assistant-1",
      initialSnapshot: snapshot,
      clock: () => 100,
    })
    const second = createOpencodeCompatProjection({
      sessionId: "session-1",
      directory: "/repo",
      assistantMessageId: "assistant-1",
      initialSnapshot: snapshot,
      clock: () => 100,
    })

    first.ingest({ type: "tool-output", toolCallId: "tool-1", output: { stdout: "done" } })

    expect(snapshot.state.toolStatusByCallId["tool-1"]).toBe("running")
    expect(second.snapshot().state.toolStatusByCallId["tool-1"]).toBe("running")
  })

  test("hydrates tool input from ACP metadata and normalizes snake_case keys", () => {
    const projection = makeProjection()

    const [event] = projection.ingest({
      type: "tool-start",
      toolCallId: "tool-1",
      toolName: "read",
      metadata: {
        acp: {
          rawInput: { file_path: "src/index.ts" },
          locations: [{ path: "src/index.ts", line: 3 }],
          intent: "read",
        },
      },
    })

    expect(event?.payload).toMatchObject({
      properties: {
        part: {
          state: {
            input: {
              file_path: "src/index.ts",
              filePath: "src/index.ts",
              intent: "read",
            },
          },
        },
      },
    })
  })

  test("hydrates projection-critical tool input from harness-neutral display fields", () => {
    const projection = makeProjection()

    const [started] = projection.ingest({
      type: "tool-start",
      toolCallId: "tool-1",
      toolName: "read",
      display: {
        intent: "read",
        filePath: "src/index.ts",
        locations: [{ path: "src/index.ts", line: 3 }],
      },
    })
    const [completed] = projection.ingest({ type: "tool-output", toolCallId: "tool-1", output: "done" })

    expect(started?.payload).toMatchObject({
      properties: {
        part: {
          state: {
            input: {
              intent: "read",
              filePath: "src/index.ts",
            },
          },
        },
      },
    })
    expect(completed?.payload).toMatchObject({
      properties: {
        part: {
          state: {
            input: {
              intent: "read",
              filePath: "src/index.ts",
            },
          },
        },
      },
    })
    expect(projection.snapshot().state.toolDisplaysByCallId["tool-1"]).toEqual({
      intent: "read",
      filePath: "src/index.ts",
      locations: [{ path: "src/index.ts", line: 3 }],
    })
  })

  test("splits text after tool activity without losing accumulated text", () => {
    const projection = makeProjection()

    projection.ingest({ type: "text-delta", delta: "before" })
    projection.ingest({ type: "tool-start", toolCallId: "tool-1", toolName: "read" })
    const after = projection.ingest({ type: "text-delta", delta: "after" })

    expect(after[0]?.payload).toMatchObject({
      type: "message.part.updated",
      properties: {
        part: {
          id: "000002_assistant-1-text-1",
          type: "text",
          text: "",
        },
      },
    })
    expect(projection.snapshot().state.accumulatedText).toBe("beforeafter")
  })

  test("renders terminal references without duplicating completed tool cards", () => {
    const projection = makeProjection()

    projection.ingest({ type: "tool-start", toolCallId: "tool-1", toolName: "bash" })
    projection.ingest({ type: "tool-output", toolCallId: "tool-1", output: "done" })
    const terminal = projection.ingest({ type: "tool-terminal", toolCallId: "tool-1", terminalId: "pty-1" })

    expect(terminal).toEqual([{
      directory: "/repo",
      payload: {
        id: "message.part.updated:assistant-1:000000_tool-1",
        type: "message.part.updated",
        properties: {
          sessionID: "session-1",
          time: 100,
          part: {
            id: "000000_tool-1",
            sessionID: "session-1",
            messageID: "assistant-1",
            type: "tool",
            callID: "tool-1",
            tool: "bash",
            metadata: { acp: { terminalId: "pty-1" } },
            state: {
              status: "completed",
              input: {},
              output: "done",
              title: "bash",
              metadata: { acp: { terminalId: "pty-1" } },
              time: { start: 100, end: 100 },
            },
          },
        },
      },
    }])
  })

  test("suppresses structured diff output on completed tool cards", () => {
    const projection = makeProjection()

    projection.ingest({ type: "tool-start", toolCallId: "tool-1", toolName: "edit" })
    const [event] = projection.ingest({
      type: "tool-output",
      toolCallId: "tool-1",
      output: [{ path: "a.ts", oldText: "a", newText: "b" }],
    })

    expect(event?.payload).toMatchObject({
      properties: {
        part: {
          state: {
            output: "",
          },
        },
      },
    })
  })

  test("projects questions and config updates to session surfaces", () => {
    const projection = makeProjection()

    expect(projection.ingest({
      type: "question",
      requestId: "question-1",
      questions: [{ text: "Pick one", options: ["A", "B"] }],
    })[0]?.payload).toMatchObject({
      type: "question.asked",
      properties: {
        id: "question-1",
        sessionID: "session-1",
        questions: [{
          question: "Pick one",
          header: "Pick one",
          options: [
            { label: "A", description: "A" },
            { label: "B", description: "B" },
          ],
          custom: false,
        }],
      },
    })

    expect(projection.ingest({
      type: "config-update",
      options: [{ id: "model", name: "Model", type: "boolean", currentValue: true }],
    })[0]?.payload).toMatchObject({
      type: "session.config",
      properties: {
        sessionID: "session-1",
        options: [{ id: "model", name: "Model", type: "boolean", currentValue: true }],
      },
    })
  })

  test("projects answered questions to question reply compatibility events", () => {
    const projection = makeProjection()

    expect(projection.ingest({
      type: "question-answered",
      requestId: "question-1",
      answers: {
        second: ["B", "C"],
        first: "A",
      },
    })).toEqual([{
      directory: "/repo",
      payload: {
        id: "question.replied:question-1",
        type: "question.replied",
        properties: {
          sessionID: "session-1",
          requestID: "question-1",
          answers: [["A"], ["B", "C"]],
        },
      },
    }])
  })

  test("terminalizes still-running tools on prompt failure", () => {
    const projection = makeProjection()

    projection.ingest({ type: "tool-start", toolCallId: "tool-1", toolName: "bash" })
    const [event] = projection.terminalizeOpenTools("prompt failed")

    expect(event?.payload).toMatchObject({
      type: "message.part.updated",
      properties: {
        part: {
          id: "000000_tool-1",
          type: "tool",
          state: {
            status: "error",
            error: "prompt failed",
            time: { start: 100, end: 100 },
          },
        },
      },
    })
    expect(projection.snapshot().state.toolStatusByCallId["tool-1"]).toBe("error")
  })
})
