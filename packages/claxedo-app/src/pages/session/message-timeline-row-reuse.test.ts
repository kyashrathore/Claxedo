import { describe, expect, test } from "bun:test"
import { TimelineRow } from "./message-timeline.data"

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
})
