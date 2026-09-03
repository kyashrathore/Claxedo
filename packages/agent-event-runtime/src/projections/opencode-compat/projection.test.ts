import { describe, expect, test } from "bun:test"
import { createOpencodeCompatProjection } from "./projection"

// The client-side composition: a consumer reading a workspace's runtime-events
// stream, where this projection is the turn's whole OpenCode-shaped producer.
function makeProjection() {
  return createOpencodeCompatProjection({
    sessionId: "session-1",
    directory: "/repo",
    // The reply id a runtime mints for the turn answering `msg_turn_1`: this
    // composition announces the row, and the id is what names its parent.
    assistantMessageId: "msg_turn_1_r",
    announcesAssistantMessage: true,
    clock: () => 100,
  })
}

describe("createOpencodeCompatProjection", () => {
  test("preserves authoritative central identity on session-info compatibility events", () => {
    expect(makeProjection().ingest({
      type: "session-info",
      title: "Pi session",
      updatedAt: "2026-06-16T00:00:00.000Z",
      parentID: "parent-session-1",
      sessionRef: "central:session-1",
      host: "central",
      workspaceID: "workspace-1",
    })[0]?.payload).toMatchObject({
      type: "session.updated",
      properties: {
        info: {
          id: "session-1",
          parentID: "parent-session-1",
          sessionRef: "central:session-1",
          host: "central",
          workspaceID: "workspace-1",
        },
      },
    })
  })

  test("preserves exact usage categories and the active message identity", () => {
    const projection = makeProjection()

    expect(projection.ingest({
      type: "usage",
      contextSize: 200_000,
      contextUsed: 24_542,
      observation: {
        kind: "cumulative",
        sequence: 2,
        providerObservationId: "provider-usage-2",
        tokens: {
          input: 4,
          output: 679,
          reasoning: null,
          cache: { read: 21_144, write: 2_715 },
        },
      },
    })[0]?.payload).toEqual({
      type: "session.usage",
      properties: {
        sessionID: "session-1",
        messageID: "msg_turn_1_r",
        contextSize: 200_000,
        contextUsed: 24_542,
        observation: {
          kind: "cumulative",
          sequence: 2,
          providerObservationId: "provider-usage-2",
          tokens: {
            input: 4,
            output: 679,
            reasoning: null,
            cache: { read: 21_144, write: 2_715 },
          },
        },
      },
    })
  })

  test("keeps subagent lifecycle out of the compatibility projection", () => {
    expect(makeProjection().ingest({
      type: "subagent-updated",
      subagentKey: "child-1",
      revision: 1,
      childSessionId: "child-session-1",
    })).toEqual([])
  })

  // A turn a VIEWER observes has no client-side origin: nothing on this
  // machine created its assistant message, and the runtime-events lane names
  // that message without ever carrying a row for it. The OpenCode consumers
  // file a part against an EXISTING message (`upsertPart` / `appendPartDelta`
  // in claxedo-app's `opencode-conversation.ts` return false for an unknown
  // message id), and the runtime's own compat producer opens every turn with
  // that row before any part (`sdk-runtime-adapter`'s `start`: busy, the user
  // row, then the assistant row). This projection stands in for that producer
  // on the runtime-events lane, so it owes its consumers the same row.
  test("announces the assistant message row before the first part of a turn", () => {
    const projection = createOpencodeCompatProjection({
      sessionId: "session-1",
      directory: "/repo",
      assistantMessageId: "msg_host_turn_r",
      announcesAssistantMessage: true,
      clock: () => 100,
    })

    const first = projection.ingest({ type: "text-delta", delta: "hel" })

    expect(first.map((event) => event.payload.type)).toEqual([
      "message.updated",
      "message.part.updated",
      "message.part.delta",
    ])
    expect(first[0]).toEqual({
      directory: "/repo",
      payload: {
        id: "message.updated:msg_host_turn_r",
        type: "message.updated",
        properties: {
          sessionID: "session-1",
          info: {
            id: "msg_host_turn_r",
            sessionID: "session-1",
            role: "assistant",
            time: { created: 100 },
            // The `${userMessageId}_r` the runtime announced: the turn this
            // reply answers, which is what puts it under that user message in
            // the timeline.
            parentID: "msg_host_turn",
            modelID: "",
            providerID: "",
            mode: "auto",
            agent: "",
            path: { cwd: "/repo", root: "/repo" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        },
      },
    })
    // Once per turn, not once per part.
    expect(projection.ingest({ type: "text-delta", delta: "lo" }).map((event) => event.payload.type)).toEqual([
      "message.part.delta",
    ])
    expect(projection.ingest({ type: "tool-start", toolCallId: "tool-1", toolName: "bash" })
      .map((event) => event.payload.type)).toEqual(["message.part.updated"])
  })

  test("the host composition announces nothing — its own producer owns the row", () => {
    // `createTurnEventProjector` (agent-sdk-runtime) and the workspace
    // runtime's `createPromptEventProjection` append their own
    // `buildAssistantMessage` row at turn start, complete with the agent and
    // model this lane never carries. A row announced here would land after it
    // and overwrite it with a thinner one.
    const projection = createOpencodeCompatProjection({
      sessionId: "session-1",
      directory: "/repo",
      assistantMessageId: "msg_turn_1_r",
      clock: () => 100,
    })

    expect(projection.ingest({ type: "text-delta", delta: "hi" }).map((event) => event.payload.type)).toEqual([
      "message.part.updated",
      "message.part.delta",
    ])
  })

  test("reports a reply id outside the turn convention instead of announcing a row", () => {
    // The lane names the reply and nothing else, so a reply id the runtime's
    // convention cannot resolve names no user message. Parenting it on the
    // session would invent a turn, so the projection says the producer broke
    // the contract and announces nothing.
    const projection = createOpencodeCompatProjection({
      sessionId: "session-1",
      directory: "/repo",
      assistantMessageId: "msg_engine_named_this",
      announcesAssistantMessage: true,
      clock: () => 100,
    })

    const events = projection.ingest({ type: "text-delta", delta: "hi" })

    expect(events.map((event) => event.payload.type)).toEqual([
      "runtime.diagnostic",
      "message.part.updated",
      "message.part.delta",
    ])
    expect(events[0]?.payload).toMatchObject({
      type: "runtime.diagnostic",
      properties: {
        sessionID: "session-1",
        projection: "opencode-compat",
        code: "projection.opencode_compat.reply_id_outside_turn_convention",
        severity: "error",
        raw: "msg_engine_named_this",
      },
    })
    // Reported once per turn, not once per part.
    expect(projection.ingest({ type: "text-delta", delta: "there" }).map((event) => event.payload.type))
      .toEqual(["message.part.delta"])
  })

  test("opens the turn's prompt row from the chunks the lane names it with", () => {
    // The other half of an attached viewer's turn: the reply hangs off the
    // prompt, so a lane that announced only the reply left its consumer with a
    // row parented on a message it never received.
    const projection = createOpencodeCompatProjection({
      sessionId: "session-1",
      directory: "/repo",
      assistantMessageId: "msg_host_turn_r",
      announcesAssistantMessage: true,
      clock: () => 100,
    })

    const first = projection.ingest({
      type: "user-message-delta",
      messageId: "msg_host_turn",
      content: { type: "text", text: "explain " },
    })
    const second = projection.ingest({
      type: "user-message-delta",
      messageId: "msg_host_turn",
      content: { type: "text", text: "this file" },
    })

    expect(first.map((event) => event.payload.type)).toEqual([
      "message.updated",
      "message.part.updated",
      "message.part.delta",
    ])
    expect(first[0]?.payload).toMatchObject({
      type: "message.updated",
      properties: { info: { id: "msg_host_turn", sessionID: "session-1", role: "user" } },
    })
    // The row is opened once; every later chunk only extends its text.
    expect(second.map((event) => event.payload.type)).toEqual(["message.part.delta"])
    expect([first.at(-1)?.payload, second[0]?.payload].map((payload) => (payload as { properties: Record<string, unknown> }).properties)).toEqual([
      { sessionID: "session-1", messageID: "msg_host_turn", partID: "000000_msg_host_turn-text", field: "text", delta: "explain " },
      { sessionID: "session-1", messageID: "msg_host_turn", partID: "000000_msg_host_turn-text", field: "text", delta: "this file" },
    ])
  })

  test("attaches a viewer turn's parts to the row it announced under the user message", () => {
    // The whole contract an attached viewer rides: the announced row names the
    // user message the reply answers, and every part of the turn is filed
    // against THAT row — the two halves a timeline needs to place the reply.
    const projection = createOpencodeCompatProjection({
      sessionId: "session-1",
      directory: "/repo",
      assistantMessageId: "msg_host_turn_r",
      announcesAssistantMessage: true,
      clock: () => 100,
    })

    const first = projection.ingest({ type: "text-delta", delta: "hel" })
    const second = projection.ingest({ type: "text-delta", delta: "lo" })

    const announced = first[0]?.payload as { properties: { info: { id: string; parentID: string } } }
    expect(announced.properties.info).toMatchObject({ id: "msg_host_turn_r", parentID: "msg_host_turn" })
    const partMessageIds = [...first.slice(1), ...second].map((event) => {
      const properties = event.payload.properties as { messageID?: string; part?: { messageID?: string } }
      return properties.part?.messageID ?? properties.messageID
    })
    expect(partMessageIds).toEqual(["msg_host_turn_r", "msg_host_turn_r", "msg_host_turn_r"])
  })

  test("names the agent the lane reported on the announced row", () => {
    const projection = makeProjection()

    projection.ingest({ type: "session-agent", agentId: "build" })

    expect(projection.ingest({ type: "text-delta", delta: "hi" })[0]?.payload).toMatchObject({
      type: "message.updated",
      properties: { info: { agent: "build" } },
    })
  })

  test("a status-only session never announces a reply row", () => {
    const projection = makeProjection()

    expect(projection.ingest({ type: "session-status", status: "busy" }).map((event) => event.payload.type))
      .toEqual(["session.status"])
    expect(projection.snapshot().state.announcedAssistantMsgId).toBeUndefined()
  })

  test("a resumed projection does not re-announce a row its consumer already has", () => {
    const first = createOpencodeCompatProjection({
      sessionId: "session-1",
      directory: "/repo",
      assistantMessageId: "msg_turn_1_r",
      announcesAssistantMessage: true,
    })
    first.ingest({ type: "text-delta", delta: "hello" })

    const next = createOpencodeCompatProjection({
      sessionId: "session-1",
      directory: "/repo",
      assistantMessageId: "msg_turn_1_r",
      announcesAssistantMessage: true,
      initialSnapshot: first.snapshot(),
    })

    expect(next.ingest({ type: "text-delta", delta: "!" }).map((event) => event.payload.type)).toEqual([
      "message.part.delta",
    ])
  })

  test("emits text deltas incrementally", () => {
    const projection = createOpencodeCompatProjection({
      sessionId: "session-1",
      directory: "/repo",
      assistantMessageId: "msg_turn_1_r",
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
      assistantMessageId: "msg_turn_1_r",
    })
    first.ingest({ type: "text-delta", delta: "hello" })

    const next = createOpencodeCompatProjection({
      sessionId: "session-1",
      directory: "/repo",
      assistantMessageId: "msg_turn_1_r",
      initialSnapshot: first.snapshot(),
    })

    expect(next.ingest({ type: "text-delta", delta: "!" })).toEqual([{
      directory: "/repo",
      payload: {
        id: "message.part.delta:msg_turn_1_r:000000_msg_turn_1_r-text",
        type: "message.part.delta",
        properties: {
          sessionID: "session-1",
          messageID: "msg_turn_1_r",
          partID: "000000_msg_turn_1_r-text",
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
      assistantMessageId: "msg_turn_1_r",
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
      harness: "acp:example",
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
        harness: "acp:example",
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
      "message.updated",
      "message.part.updated",
      "message.part.delta",
    ])
    expect(projection.ingest({ type: "proposed-plan-complete", planMarkdown: "## Plan\n- inspect" })).toEqual([{
      directory: "/repo",
      payload: {
        id: "message.part.delta:msg_turn_1_r:000000_msg_turn_1_r-text",
        type: "message.part.delta",
        properties: {
          sessionID: "session-1",
          messageID: "msg_turn_1_r",
          partID: "000000_msg_turn_1_r-text",
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

    // The tool part is this turn's first, so it carries the assistant row.
    const completed = projection.ingest({ type: "tool-output", toolCallId: "tool-1", output: "done" })
      .filter((event) => event.payload.type !== "message.updated")
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
    // A throw leaves nothing announced either, so the retry still opens with
    // the assistant row its part needs.
    expect(projection.ingest({ type: "text-delta", delta: "ok" }).map((event) => event.payload.type)).toEqual([
      "message.updated",
      "message.part.updated",
      "message.part.delta",
    ])
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
      assistantMessageId: "msg_turn_1_r",
      initialSnapshot: snapshot,
      clock: () => 100,
    })
    const second = createOpencodeCompatProjection({
      sessionId: "session-1",
      directory: "/repo",
      assistantMessageId: "msg_turn_1_r",
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
    }).filter((item) => item.payload.type !== "message.updated")

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
    }).filter((item) => item.payload.type !== "message.updated")
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
          id: "000002_msg_turn_1_r-text-1",
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
        id: "message.part.updated:msg_turn_1_r:000000_tool-1",
        type: "message.part.updated",
        properties: {
          sessionID: "session-1",
          time: 100,
          part: {
            id: "000000_tool-1",
            sessionID: "session-1",
            messageID: "msg_turn_1_r",
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

  test("keeps the provider error sentence instead of a placeholder session.error", () => {
    const projection = makeProjection()
    const status = projection.ingest({ type: "session-status", status: "error" })
    const failed = projection.ingest({
      type: "error",
      error: "You've reached your Codex rate limit. It will reset in about 5 hours.",
    })

    expect(status).toEqual([])
    expect(failed).toEqual([{
      directory: "/repo",
      payload: {
        id: "session.error:session-1",
        type: "session.error",
        properties: {
          sessionID: "session-1",
          error: {
            name: "UnknownError",
            data: { message: "You've reached your Codex rate limit. It will reset in about 5 hours." },
          },
        },
      },
    }])
  })
})
