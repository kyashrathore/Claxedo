import { describe, expect, test } from "bun:test"
import { foldTurnOutline, type OutlineTextRow } from "./turn-outline"

const text = (message_id: string, value: string, flags: Partial<OutlineTextRow> = {}): OutlineTextRow => ({
  message_id,
  text: value,
  synthetic: null,
  ignored: null,
  ...flags,
})

describe("foldTurnOutline", () => {
  test("previews a turn from its user's own text alone", () => {
    const outline = foldTurnOutline(
      {
        users: [
          { id: "user-1", created_at: 10, title: null },
          { id: "user-2", created_at: 20, title: "Second" },
        ],
        texts: [
          text("user-1", "  first\n\nprompt  "),
          text("user-1", "HIDDEN", { synthetic: 1 }),
          text("user-1", "IGNORED", { ignored: 1 }),
          text("user-2", "second prompt that runs on past the cut"),
        ],
        complete: false,
      },
      16,
    )
    expect(outline).toEqual({
      complete: false,
      turns: [
        { id: "user-1", createdAt: 10, user: "first prompt" },
        { id: "user-2", createdAt: 20, title: "Second", user: "second prompt th" },
      ],
    })
  })

  test("a window with no turns is complete and empty", () => {
    expect(foldTurnOutline({ users: [], texts: [], complete: true })).toEqual({ turns: [], complete: true })
  })
})
