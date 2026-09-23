import { describe, expect, test } from "bun:test"
import type { AgentAssistantMessage as AssistantMessage, AgentContentPart as Part, AgentUserMessage as UserMessage } from "@claxedo/agent-runtime-contract"
import { Timeline } from "./message-timeline.data"
import { TimelineRow } from "./timeline-row-model"

describe("timeline row reuse", () => {
  test("renders a durable cross-harness boundary as a named divider", () => {
    const marker = textPart("part_handoff", "msg_handoff", "")
    Object.assign(marker, {
      from: { id: "claude", access: "native" },
      to: { id: "codex", access: "native" },
    })
    Object.defineProperty(marker, "type", { value: "handoff" })

    const rows = Timeline.constructMessageRows(
      userMessage("msg_handoff"),
      () => [marker],
      [],
      1,
      false,
      "idle",
      false,
    )

    expect(rows.find((row) => row._tag === "TurnDivider")).toEqual(
      expect.objectContaining({ label: "handoff", harness: "Codex" }),
    )
  })

  test("bounds cold assistant part rows without truncating canonical turn semantics", () => {
    const hidden = assistantMessage("msg_hidden", "msg_user", { completed: 15 })
    hidden.error = {
      name: "UnknownError",
      data: { message: "hidden sibling failed" },
    } as AssistantMessage["error"]
    const final = assistantMessage("msg_final", "msg_user", { completed: 20 })
    const parts = new Map<string, Part[]>([
      [hidden.id, [textPart("part_hidden", hidden.id, "intermediate")]],
      [final.id, [textPart("part_final", final.id, "answer")]],
    ])

    const rows = Timeline.constructMessageRows(
      userMessage("msg_user"),
      (messageID) => parts.get(messageID) ?? [],
      [hidden, final],
      0,
      false,
      "idle",
      false,
      true,
      () => undefined,
      undefined,
      new Set([final.id]),
    )

    const assistantRows = rows.filter((row) => row._tag === "AssistantPart")
    expect(assistantRows).toHaveLength(1)
    expect(TimelineRow.contentMessageID(assistantRows[0])).toBe(final.id)
    expect(rows.find((row) => row._tag === "Error")).toEqual(
      expect.objectContaining({ text: "hidden sibling failed" }),
    )
  })

  test("token updates replace only changed row references in a large timeline", () => {
    const previous = Array.from({ length: 10_000 }, (_, index) =>
      TimelineRow.UserMessage({
        userMessageID: `msg_${index}`,
        anchor: true,
        previousUserMessage: index > 0,
      })
    )
    const next = previous.map((row, index) =>
      index === 7_321
        ? TimelineRow.UserMessage({
            userMessageID: row.userMessageID,
            anchor: false,
            previousUserMessage: row.previousUserMessage,
          })
        : TimelineRow.UserMessage({
            userMessageID: row.userMessageID,
            anchor: row.anchor,
            previousUserMessage: row.previousUserMessage,
          })
    )

    const reused = TimelineRow.reuse(previous, next)
    const changed = reused.filter((row, index) => row !== previous[index])

    expect(changed).toEqual([next[7_321]])
    expect(reused[0]).toBe(previous[0])
    expect(reused.at(-1)).toBe(previous.at(-1))
  })

  test("drops malformed rows before render code reads row tags", () => {
    const row = TimelineRow.UserMessage({
      userMessageID: "msg_1",
      anchor: true,
    })

    // as-any: malformed-row fixture verifies reuse drops invalid timeline entries.
    const reused = TimelineRow.reuse([undefined as unknown as TimelineRow.TimelineRow], [
      // as-any: malformed-row fixture verifies reuse drops invalid timeline entries.
      undefined as unknown as TimelineRow.TimelineRow,
      row,
    ])

    expect(reused).toEqual([row])
  })

  test("the PreviousMessages row is reused while its count and head turn hold, and replaced when the count moves", () => {
    const row = TimelineRow.PreviousMessages({ userMessageID: "msg_head", count: 3 })
    const sameCount = TimelineRow.PreviousMessages({ userMessageID: "msg_head", count: 3 })
    const fewer = TimelineRow.PreviousMessages({ userMessageID: "msg_head", count: 2 })
    const otherHead = TimelineRow.PreviousMessages({ userMessageID: "msg_other", count: 3 })

    expect(TimelineRow.key(row)).toBe("previous-messages:msg_head")
    expect(TimelineRow.equals(row, sameCount)).toBe(true)
    expect(TimelineRow.equals(row, fewer)).toBe(false)
    expect(TimelineRow.equals(row, otherHead)).toBe(false)
    expect(TimelineRow.anchorsMessage(row)).toBe(false)

    expect(TimelineRow.reuse([row], [sameCount])).toEqual([row])
    expect(TimelineRow.reuse([row], [fewer])[0]).toBe(fewer)
  })

  test("stale busy status does not hide a completed assistant response behind thinking", () => {
    const rows = Timeline.constructMessageRows(
      userMessage("msg_user"),
      (messageID) => messageID === "msg_assistant" ? [textPart("part_text", "msg_assistant", "opencode-1")] : [],
      [assistantMessage("msg_assistant", "msg_user", { completed: 20 })],
      0,
      false,
      "busy",
      true,
    )

    expect(rows.map((row) => row._tag)).toEqual(["UserMessage", "AssistantPart"])
  })

  test("emits Thinking while the active turn is busy and unsettled without assistant parts", () => {
    const rows = Timeline.constructMessageRows(
      userMessage("msg_user"),
      () => [],
      [assistantMessage("msg_assistant", "msg_user")],
      0,
      false,
      "busy",
      true,
    )
    expect(rows.some((row) => row._tag === "Thinking")).toBe(true)
  })

  describe("a cold switch folds from the first frame", () => {
    const rows = (parts: Part[], fragment: boolean, prior?: number) =>
      Timeline.constructMessageRows(
        userMessage("msg_user"),
        (messageID) => (messageID === "msg_assistant" ? parts : []),
        [assistantMessage("msg_assistant", "msg_user", { completed: 20 })],
        0,
        false,
        "idle",
        true,
        false,
        () => undefined,
        undefined,
        undefined,
        () => prior,
        undefined,
        false,
        () => fragment,
      )
    const fold = (list: TimelineRow.TimelineRow[]) => list.find((row): row is TimelineRow.TurnFold => row._tag === "TurnFold")
    const surface = [textPart("p1", "msg_assistant", "Let me look."), textPart("p2", "msg_assistant", "Done.")]
    const full = [
      textPart("p1", "msg_assistant", "Let me look."),
      toolPart("t1", "msg_assistant", "bash", "completed"),
      toolPart("t2", "msg_assistant", "read", "completed"),
      textPart("p2", "msg_assistant", "Done."),
    ]

    test("the latest-surface frame is folded before the tools arrive, and stays folded when they do", () => {
      expect(fold(rows(surface, true))?.folded).toBe(true)
      expect(rows(surface, true).filter((row) => row._tag === "AssistantPart")).toHaveLength(1)
      expect(fold(rows(full, false))?.folded).toBe(true)
      expect(rows(full, false).filter((row) => row._tag === "AssistantPart")).toHaveLength(1)
    })

    test("the same texts read canonically do not fold: there is nothing to hide", () => {
      expect(fold(rows(surface, false))).toBeUndefined()
    })

    test("a turn that would paint open from the preview holds its body behind a loader until the full read", () => {
      const aborted = { ...assistantMessage("msg_assistant", "msg_user", { completed: 20 }), error: { name: "MessageAbortedError", data: {} } } as AssistantMessage
      const interrupted = (parts: Part[], fragment: boolean) =>
        Timeline.constructMessageRows(
          userMessage("msg_user"),
          (messageID) => (messageID === "msg_assistant" ? parts : []),
          [aborted],
          0,
          false,
          "idle",
          true,
          false,
          () => undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          false,
          () => fragment,
        )
      expect(interrupted(surface, true).map((row) => row._tag)).toEqual(["UserMessage", "TurnLoading"])
      const landed = interrupted(full, false).map((row) => row._tag)
      expect(landed).not.toContain("TurnLoading")
      expect(landed.filter((tag) => tag === "AssistantPart")).toHaveLength(4)
      expect(fold(interrupted(full, false))?.folded).toBe(false)
    })

    test("a working turn paints its fragment instead of holding it", () => {
      const build = (assistant: AssistantMessage, status: "busy" | "idle", settlePending: boolean) =>
        Timeline.constructMessageRows(
          userMessage("msg_user"),
          (messageID) => (messageID === "msg_assistant" ? [textPart("p1", "msg_assistant", "Let me look.")] : []),
          [assistant],
          0,
          false,
          status,
          true,
          false,
          () => undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          settlePending,
          () => true,
        ).map((row) => row._tag)
      const open = assistantMessage("msg_assistant", "msg_user", { created: 10 })
      expect(build(open, "busy", false)).toEqual(["UserMessage", "AssistantPart", "Thinking"])
      const settledAwaitingRead = assistantMessage("msg_assistant", "msg_user", { completed: 20 })
      expect(build(settledAwaitingRead, "idle", true)).toEqual(["UserMessage", "AssistantPart"])
    })

    test("a turn the reader unfolded holds its body the same way", () => {
      const unfolded = Timeline.constructMessageRows(
        userMessage("msg_user"),
        (messageID) => (messageID === "msg_assistant" ? surface : []),
        [assistantMessage("msg_assistant", "msg_user", { completed: 20 })],
        0,
        false,
        "idle",
        true,
        false,
        () => false,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        () => true,
      )
      expect(unfolded.map((row) => row._tag)).toEqual(["UserMessage", "TurnLoading"])
    })

    test("a fold shown on the preview is a floor: the full read cannot take the row away", () => {
      const shown = fold(rows(surface, true))
      expect(shown?.foldCount).toBe(2)
      const landed = rows([textPart("p1", "msg_assistant", "Hi.")], false, shown?.foldCount)
      expect(fold(landed)?.folded).toBe(true)
    })
  })

  describe("the live row flips between the trailing tool group and Thinking", () => {
    const busyRows = (parts: Part[], showReasoning = false) =>
      Timeline.constructMessageRows(
        userMessage("msg_user"),
        (messageID) => (messageID === "msg_assistant" ? parts : []),
        [assistantMessage("msg_assistant", "msg_user")],
        0,
        showReasoning,
        "busy",
        true,
      )
    const thinking = (rows: TimelineRow.TimelineRow[]) => rows.some((row) => row._tag === "Thinking")

    test("a running tool at the tail is the live row, so no Thinking row stacks under it", () => {
      expect(thinking(busyRows([toolPart("p1", "msg_assistant", "bash", "running")]))).toBe(false)
    })

    test("a completed tool still at the tail keeps the group header live instead of a Thinking row", () => {
      expect(thinking(busyRows([toolPart("p1", "msg_assistant", "bash", "completed")]))).toBe(false)
    })

    test("text after the tools puts the turn back into Thinking", () => {
      expect(
        thinking(
          busyRows([
            toolPart("p1", "msg_assistant", "bash", "completed"),
            textPart("p2", "msg_assistant", "Now the next step."),
          ]),
        ),
      ).toBe(true)
    })

    test("a streaming thought is its own live row when reasoning summaries are shown", () => {
      const parts = [textPart("p1", "msg_assistant", "Let me look."), reasoningPart("r1", "msg_assistant", "hmm")]
      expect(thinking(busyRows(parts, true))).toBe(false)
      expect(thinking(busyRows(parts, false))).toBe(true)
    })

    test("a step-per-message turn keeps Thinking while its newest message is open", () => {
      const rows = Timeline.constructMessageRows(
        userMessage("msg_user"),
        (messageID) => (messageID === "msg_step1" ? [toolPart("p1", "msg_step1", "bash", "completed")] : []),
        [assistantMessage("msg_step1", "msg_user", { completed: 20 }), assistantMessage("msg_step2", "msg_user")],
        0,
        false,
        "busy",
        true,
      )
      expect(thinking(rows)).toBe(true)
    })
  })

  test("drops Thinking as soon as status leaves busy (hold is applied by the timeline shell)", () => {
    const busy = Timeline.constructMessageRows(
      userMessage("msg_user"),
      () => [],
      [assistantMessage("msg_assistant", "msg_user")],
      0,
      false,
      "busy",
      true,
    )
    const idle = Timeline.constructMessageRows(
      userMessage("msg_user"),
      () => [],
      [assistantMessage("msg_assistant", "msg_user")],
      0,
      false,
      "idle",
      true,
    )
    expect(busy.some((row) => row._tag === "Thinking")).toBe(true)
    expect(idle.some((row) => row._tag === "Thinking")).toBe(false)
  })

  test("every failed turn receives the typed recovery card row, not only the first", () => {
    const failed = assistantMessage("msg_assistant", "msg_user", { completed: 20 })
    failed.error = {
      name: "UnknownError",
      data: { message: "bad key", firstTurnErrorClass: "credential" },
    } as AssistantMessage["error"]

    const first = Timeline.constructMessageRows(userMessage("msg_user"), () => [], [failed], 0, false, "idle", false)
    const later = Timeline.constructMessageRows(userMessage("msg_later"), () => [], [failed], 1, false, "idle", false)

    expect(first.find((row) => row._tag === "Error")).toEqual(expect.objectContaining({ recoveryClass: "credential" }))
    expect(later.find((row) => row._tag === "Error")).toEqual(expect.objectContaining({ recoveryClass: "credential" }))
  })

  test("legacy turn-admission failures use compact inline treatment instead of a recovery card", () => {
    const failed = assistantMessage("msg_assistant", "msg_user", { completed: 20 })
    failed.error = {
      name: "UnknownError",
      data: {
        message: "Session is already processing a message",
        firstTurnErrorClass: "unknown",
      },
    } as AssistantMessage["error"]

    const rows = Timeline.constructMessageRows(userMessage("msg_user"), () => [], [failed], 0, false, "idle", false)

    expect(rows.find((row) => row._tag === "Error")).toEqual(expect.objectContaining({
      presentation: "turn-conflict",
      summary: "The previous message was still finishing. Try again.",
    }))
  })

  test("the error row carries the provider's status and body, not just the message", () => {
    const body = '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'
    const failed = assistantMessage("msg_assistant", "msg_user", { completed: 20 })
    failed.error = {
      name: "APIError",
      data: { message: "Unauthorized", statusCode: 401, isRetryable: false, responseBody: body },
    } as AssistantMessage["error"]

    const rows = Timeline.constructMessageRows(userMessage("msg_user"), () => [], [failed], 0, false, "idle", false)
    const row = rows.find((row) => row._tag === "Error")

    // The body is what distinguishes an expired key from a gateway flake, so it
    // must survive the trip to the card rather than being dropped here.
    expect(row).toEqual(
      expect.objectContaining({ providerID: "opencode", modelID: "big-pickle" }),
    )
    expect((row as { text: string }).text).toContain(body)
    expect((row as { error: { data: { statusCode: number } } }).error.data.statusCode).toBe(401)
  })

  // The raw text flashed as the primary line before the card's derived
  // summary mounted. The row now carries the human sentence itself, so there
  // is no window in which raw provider bytes are the primary line.
  test("carries the human summary on the row so the first paint is never raw", () => {
    const body = '{"type":"error","error":{"type":"authentication_error"}}'
    const failed = assistantMessage("msg_assistant", "msg_user", { completed: 20 })
    failed.error = {
      name: "APIError",
      data: { message: "Unauthorized", statusCode: 401, responseBody: body },
    } as AssistantMessage["error"]

    const rows = Timeline.constructMessageRows(userMessage("msg_user"), () => [], [failed], 0, false, "idle", false)
    const row = rows.find((row) => row._tag === "Error") as { text: string; summary?: string }

    expect(row.summary).toBe(
      "OpenCode gateway rejected the credential (401). Check your API key in Settings, then try again.",
    )
    // The summary is a sentence, never the raw bytes.
    expect(row.summary).not.toContain(body)
    // The raw bytes still exist for the collapsed disclosure.
    expect(row.text).toContain(body)
  })

  test("every failed turn's row has a summary, so no state can paint raw as primary", () => {
    const shapes: Array<AssistantMessage["error"]> = [
      { name: "UnknownError", data: {} } as AssistantMessage["error"],
      { name: "UnknownError", data: { message: "fetch failed" } } as AssistantMessage["error"],
      { name: "APIError", data: { message: "boom", statusCode: 502 } } as AssistantMessage["error"],
    ]

    for (const shape of shapes) {
      const failed = assistantMessage("msg_assistant", "msg_user", { completed: 20 })
      failed.error = shape
      const rows = Timeline.constructMessageRows(userMessage("msg_user"), () => [], [failed], 0, false, "idle", false)
      const row = rows.find((row) => row._tag === "Error") as { summary?: string }
      expect(row.summary?.trim()).toBeTruthy()
      expect(row.summary).not.toMatch(/no more detail was reported|something went wrong/i)
    }
  })

  test("strips the relay's own provider label from the rendered error text", () => {
    const failed = assistantMessage("msg_assistant", "msg_user", { completed: 20 })
    failed.error = {
      name: "APIError",
      data: { message: "Error from provider (Console): Upstream request failed", statusCode: 502 },
    } as AssistantMessage["error"]

    const rows = Timeline.constructMessageRows(userMessage("msg_user"), () => [], [failed], 0, false, "idle", false)
    const row = rows.find((row) => row._tag === "Error") as { text: string }

    expect(row.text).toBe("Upstream request failed")
    expect(row.text).not.toContain("Console")
  })
})

describe("T8: interrupted-turn detection (D2)", () => {
  test("opencode-native MessageAbortedError still renders the interrupted divider, not an Error row", () => {
    const aborted = assistantMessage("msg_assistant", "msg_user", {})
    aborted.error = { name: "MessageAbortedError", data: { message: "Aborted" } } as AssistantMessage["error"]

    const rows = Timeline.constructMessageRows(userMessage("msg_user"), () => [], [aborted], 0, false, "idle", false)

    expect(rows.map((row) => row._tag)).toContain("TurnDivider")
    expect(rows.find((row) => row._tag === "TurnDivider")).toEqual(
      expect.objectContaining({ label: "interrupted" }),
    )
    expect(rows.find((row) => row._tag === "Error")).toBeUndefined()
  })

  test("a legacy persisted Codex abort error renders the interrupted divider", () => {
    const aborted = assistantMessage("msg_assistant", "msg_user", {})
    aborted.error = {
      name: "UnknownError",
      data: { message: "Codex turn aborted" },
    } as AssistantMessage["error"]
    const rows = Timeline.constructMessageRows(
      userMessage("msg_user"),
      () => [],
      [aborted],
      0,
      false,
      "idle",
      false,
      true,
      () => undefined,
    )

    expect(rows.map((row) => row._tag)).toEqual(["UserMessage", "TurnDivider"])
  })

  test("a canonical SDK-runtime cancellation renders the interrupted divider, not an Error row", () => {
    const unsettled = assistantMessage("msg_assistant", "msg_user", {})

    const rows = Timeline.constructMessageRows(
      userMessage("msg_user"),
      () => [],
      [unsettled],
      0,
      false,
      "idle",
      false,
      true,
      () => undefined,
      { status: "cancelled", completedAt: 45, assistantMessageId: "msg_assistant" },
    )

    expect(rows.find((row) => row._tag === "TurnDivider")).toEqual(
      expect.objectContaining({ label: "interrupted" }),
    )
    expect(rows.find((row) => row._tag === "Error")).toBeUndefined()
  })

  test("a canonical SDK-runtime cancellation hides the open tool card", () => {
    const rows = Timeline.constructMessageRows(
      userMessage("msg_user"),
      (messageID) => messageID === "msg_assistant" ? [runningToolPart("tool-1", messageID)] : [],
      [assistantMessage("msg_assistant", "msg_user", {})],
      0,
      false,
      "idle",
      false,
      true,
      () => undefined,
      { status: "cancelled", completedAt: 45, assistantMessageId: "msg_assistant" },
    )

    expect(rows.map((row) => row._tag)).toEqual(["UserMessage", "TurnDivider"])
  })

  test("a canonical SDK-runtime cancellation wins over a late harness abort error", () => {
    const aborted = assistantMessage("msg_assistant", "msg_user", {})
    aborted.error = {
      name: "UnknownError",
      data: { message: "Codex turn aborted" },
    } as AssistantMessage["error"]
    const rows = Timeline.constructMessageRows(
      userMessage("msg_user"),
      () => [],
      [aborted],
      0,
      false,
      "idle",
      false,
      true,
      () => undefined,
      { status: "cancelled", completedAt: 45, assistantMessageId: "msg_assistant" },
    )

    expect(rows.map((row) => row._tag)).toEqual(["UserMessage", "TurnDivider"])
  })

  test("an unsettled SDK message with no cancellation outcome does not render a false interruption", () => {
    const unsettled = assistantMessage("msg_assistant", "msg_user", {})

    const rows = Timeline.constructMessageRows(userMessage("msg_user"), () => [], [unsettled], 0, false, "idle", true)

    expect(rows.find((row) => row._tag === "TurnDivider")).toBeUndefined()
  })

  test("a completed turn with delayed message settlement does not render a false interruption", () => {
    const unsettled = assistantMessage("msg_assistant", "msg_user", {})

    const rows = Timeline.constructMessageRows(
      userMessage("msg_user"),
      () => [],
      [unsettled],
      0,
      false,
      "idle",
      false,
      true,
      () => undefined,
      { status: "completed", completedAt: 45, assistantMessageId: "msg_assistant" },
    )

    expect(rows.find((row) => row._tag === "TurnDivider")).toBeUndefined()
  })

  test("a turn mid-retry (status retry, unsettled) is not misclassified as interrupted", () => {
    const retrying = assistantMessage("msg_assistant", "msg_user", {})

    const rows = Timeline.constructMessageRows(userMessage("msg_user"), () => [], [retrying], 0, false, "retry", true)

    expect(rows.find((row) => row._tag === "TurnDivider")).toBeUndefined()
    expect(rows.find((row) => row._tag === "Retry")).toBeDefined()
  })

  test("a normal (settled) error keeps rendering the Error row, not the interrupted divider", () => {
    const failed = assistantMessage("msg_assistant", "msg_user", { completed: 20 })
    failed.error = { name: "UnknownError", data: { message: "boom" } } as AssistantMessage["error"]

    const rows = Timeline.constructMessageRows(userMessage("msg_user"), () => [], [failed], 0, false, "idle", false)

    expect(rows.find((row) => row._tag === "Error")).toBeDefined()
    expect(rows.find((row) => row._tag === "TurnDivider")).toBeUndefined()
  })

  test("the interrupted divider carries the canonical cancellation duration", () => {
    const unsettled = assistantMessage("msg_assistant", "msg_user", {})

    const rows = Timeline.constructMessageRows(
      userMessage("msg_user"),
      () => [],
      [unsettled],
      0,
      false,
      "idle",
      false,
      true,
      () => undefined,
      { status: "cancelled", completedAt: 45, assistantMessageId: "msg_assistant" },
    )

    const divider = rows.find((row) => row._tag === "TurnDivider")
    expect(divider).toEqual(expect.objectContaining({ label: "interrupted", durationMs: 44 }))
  })
})

function userMessage(id: string): UserMessage {
  return {
    id,
    sessionID: "ses_1",
    role: "user",
    time: { created: 1 },
  } as UserMessage
}

function assistantMessage(
  id: string,
  parentID: string,
  time: AssistantMessage["time"],
): AssistantMessage {
  return {
    id,
    sessionID: "ses_1",
    role: "assistant",
    time: { created: 2, ...time },
    parentID,
    modelID: "big-pickle",
    providerID: "opencode",
    mode: "build",
    agent: "build",
    path: { cwd: "/workspace", root: "/workspace" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

function toolPart(id: string, messageID: string, tool: string, status: "running" | "completed"): Part {
  const state =
    status === "running"
      ? { status, input: { command: "ls" }, time: { start: 1 } }
      : { status, input: { command: "ls" }, output: "ok", title: tool, metadata: {}, time: { start: 1, end: 2 } }
  return { id, sessionID: "ses_1", messageID, type: "tool", tool, callID: `${id}_c`, state } as Part
}

function reasoningPart(id: string, messageID: string, text: string): Part {
  return { id, sessionID: "ses_1", messageID, type: "reasoning", text, time: { start: 1 } } as Part
}

function textPart(id: string, messageID: string, text: string): Part {
  return {
    id,
    sessionID: "ses_1",
    messageID,
    type: "text",
    text,
  } as Part
}

function runningToolPart(id: string, messageID: string): Part {
  return {
    id,
    sessionID: "ses_1",
    messageID,
    type: "tool",
    callID: id,
    tool: "read",
    state: { status: "running", input: { file: "README.md" }, time: { start: 2 } },
  }
}
