import { describe, expect, test } from "bun:test"
import type { AssistantMessage, UserMessage } from "@opencode-ai/sdk/v2"
import { Timeline, TimelineRow } from "./message-timeline.data"

describe("timeline row reuse", () => {
  test("token updates replace only changed row references in a large timeline", () => {
    const previous = Array.from({ length: 10_000 }, (_, index) =>
      new TimelineRow.UserMessage({
        userMessageID: `msg_${index}`,
        anchor: true,
        previousUserMessage: index > 0,
      })
    )
    const next = previous.map((row, index) =>
      index === 7_321
        ? new TimelineRow.UserMessage({
            userMessageID: row.userMessageID,
            anchor: false,
            previousUserMessage: row.previousUserMessage,
          })
        : new TimelineRow.UserMessage({
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
    const row = new TimelineRow.UserMessage({
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
      false,
      { status: "cancelled", completedAt: 45, assistantMessageId: "msg_assistant" },
    )

    expect(rows.find((row) => row._tag === "TurnDivider")).toEqual(
      expect.objectContaining({ label: "interrupted" }),
    )
    expect(rows.find((row) => row._tag === "Error")).toBeUndefined()
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
      false,
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
      false,
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

function textPart(id: string, messageID: string, text: string): Part {
  return {
    id,
    sessionID: "ses_1",
    messageID,
    type: "text",
    text,
  } as Part
}
