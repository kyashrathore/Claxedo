import { describe, expect, test } from "bun:test"
import {
  absorbView,
  addNote,
  applySettings,
  columnNotes,
  convertToAction,
  createBoard,
  exportMarkdown,
  findNote,
  followUpPrompt,
  formatClock,
  isIsoDate,
  mergeSelected,
  remainingVotes,
  removeNote,
  startTimer,
  stopTimer,
  timerPercent,
  timerRemaining,
  toggleSelected,
  vote,
  type Board,
} from "./model"

const T0 = Date.UTC(2026, 9, 18, 15)

function must(change: { board: Board; error?: string }): Board {
  if (change.error) throw new Error(change.error)
  return change.board
}

function select(board: Board, ids: string[]): Board {
  return ids.reduce((current, id) => must(toggleSelected(current, id)), board)
}

describe("notes", () => {
  test("the seeded board has notes in the first two columns", () => {
    const board = createBoard()
    expect(columnNotes(board, "well")).toHaveLength(2)
    expect(columnNotes(board, "improve")).toHaveLength(3)
    expect(columnNotes(board, "actions")).toHaveLength(0)
    expect(createBoard(false).notes).toHaveLength(0)
  })

  test("adding trims, rejects empty, overlong, duplicate and unknown-column notes", () => {
    const board = createBoard()
    expect(addNote(board, "well", "   ").error).toMatch(/Write the note/)
    expect(addNote(board, "well", "x".repeat(281)).error).toMatch(/under 280/)
    expect(addNote(board, "well", "deploys were smooth all sprint").error).toMatch(/already/)
    expect(addNote(board, "later", "x").error).toMatch(/Unknown column/)
    const added = must(addNote(board, "well", "  Shipped on time  "))
    expect(columnNotes(added, "well").at(-1)?.text).toBe("Shipped on time")
    expect(columnNotes(added, "well").at(-1)?.id).toBe("note-6")
  })
})

describe("voting", () => {
  test("each vote spends one of the person's votes until none are left", () => {
    let board = createBoard()
    for (let index = 0; index < 3; index += 1) board = must(vote(board, "note-3"))
    expect(findNote(board, "note-3")?.votes).toBe(3)
    expect(remainingVotes(board)).toBe(0)
    expect(vote(board, "note-1").error).toMatch(/all 3 votes/)
  })

  test("raising the limit gives more votes and lowering it below what was spent leaves none", () => {
    const spent = must(vote(must(vote(createBoard(), "note-1")), "note-2"))
    expect(remainingVotes(applySettings(spent, { maxVotes: 5 }))).toBe(3)
    expect(remainingVotes(applySettings(spent, { maxVotes: 1 }))).toBe(0)
    expect(applySettings(spent, { maxVotes: 50 }).maxVotes).toBe(10)
  })

  test("settings read the pickers' choice lists as well as plain numbers", () => {
    const board = applySettings(createBoard(), { maxVotes: ["5"], timerMinutes: ["10"] })
    expect(board.maxVotes).toBe(5)
    expect(board.timer.durationSeconds).toBe(600)
    expect(applySettings(board, { maxVotes: [], timerMinutes: ["soon"] })).toMatchObject({ maxVotes: 5, timer: { durationSeconds: 600 } })
  })

  test("actions and missing notes cannot be voted on", () => {
    const withAction = must(convertToAction(createBoard(), "note-4", "Sam", "2026-10-30"))
    expect(vote(withAction, "note-6").error).toMatch(/not voted/)
    expect(vote(withAction, "nope").error).toMatch(/gone/)
  })

  test("sorting by votes orders a column highest first and keeps insertion order otherwise", () => {
    const board = must(vote(must(vote(createBoard(), "note-5")), "note-4"))
    const voted = must(vote(board, "note-5"))
    expect(columnNotes(voted, "improve").map((item) => item.id)).toEqual(["note-3", "note-4", "note-5"])
    expect(columnNotes(applySettings(voted, { sortByVotes: true }), "improve").map((item) => item.id)).toEqual(["note-5", "note-4", "note-3"])
  })
})

describe("merging", () => {
  test("two selected notes in one column merge into the first, adding their votes", () => {
    const voted = must(vote(must(vote(createBoard(), "note-3")), "note-5"))
    const merged = must(mergeSelected(select(voted, ["note-3", "note-5"])))
    const note = findNote(merged, "note-3")
    expect(note?.text).toBe("Flaky end-to-end tests slowed reviews / E2E suite fails randomly on CI")
    expect(note?.votes).toBe(2)
    expect(note?.mergedCount).toBe(2)
    expect(note?.selected).toBe(false)
    expect(findNote(merged, "note-5")).toBeUndefined()
    expect(merged.votesUsed).toBe(2)
  })

  test("merging needs exactly two notes from the same column", () => {
    expect(mergeSelected(select(createBoard(), ["note-3"])).error).toMatch(/exactly two notes to merge \(1 selected\)/)
    expect(mergeSelected(select(createBoard(), ["note-1", "note-3"])).error).toMatch(/same column/)
  })

  test("selecting toggles a discussed note and refuses actions and missing notes", () => {
    const board = select(createBoard(), ["note-3"])
    expect(findNote(board, "note-3")?.selected).toBe(true)
    expect(findNote(must(toggleSelected(board, "note-3")), "note-3")?.selected).toBe(false)
    expect(toggleSelected(board, "note-99").error).toBe("That note is gone.")
    const withAction = must(convertToAction(createBoard(), "note-4", "Sam", "2026-10-30"))
    const action = columnNotes(withAction, "actions")[0]
    expect(toggleSelected(withAction, action?.id ?? "").error).toMatch(/not selected/)
  })

  test("absorbing the page keeps per-note drafts, leaves selection to the plugin and ignores junk", () => {
    const board = absorbView(createBoard(), { improve: [{ id: "note-4", ownerDraft: "Sam", dueDraft: "2026-11-01", selected: true }, "junk"], well: null })
    expect(findNote(board, "note-4")?.ownerDraft).toBe("Sam")
    expect(findNote(board, "note-4")?.selected).toBe(false)
    expect(absorbView(createBoard(), null).notes).toEqual(createBoard().notes)
  })
})

describe("actions", () => {
  test("a to-improve note becomes an action with an owner and due date, once", () => {
    const board = must(convertToAction(createBoard(), "note-4", " Sam ", "2026-10-30"))
    const action = findNote(board, "note-6")
    expect(action).toBeTruthy()
    expect(action?.column).toBe("actions")
    expect(action?.owner).toBe("Sam")
    expect(action?.sourceId).toBe("note-4")
    expect(findNote(board, "note-4")?.convertedTo).toBe("note-6")
    expect(convertToAction(board, "note-4", "Sam", "2026-10-30").error).toMatch(/already has an action/)
  })

  test("conversion validates the source column, owner and date", () => {
    const board = createBoard()
    expect(convertToAction(board, "note-1", "Sam", "2026-10-30").error).toMatch(/to-improve/)
    expect(convertToAction(board, "note-4", " ", "2026-10-30").error).toMatch(/owner/)
    expect(convertToAction(board, "note-4", "Sam", "2026-02-30").error).toMatch(/due date/)
    expect(isIsoDate("2026-10-30")).toBe(true)
    expect(isIsoDate("30/10/2026")).toBe(false)
  })

  test("removing a note refunds its votes and frees its source note", () => {
    const converted = must(convertToAction(createBoard(), "note-4", "Sam", "2026-10-30"))
    expect(findNote(removeNote(converted, "note-6"), "note-4")?.convertedTo).toBeNull()
    const voted = must(vote(createBoard(), "note-1"))
    expect(removeNote(voted, "note-1").votesUsed).toBe(0)
  })
})

describe("timer", () => {
  test("counts down from the configured minutes and reports progress", () => {
    const board = startTimer(applySettings(createBoard(), { timerMinutes: 2 }), T0)
    expect(timerRemaining(board.timer, T0 + 30_000)).toBe(90)
    expect(timerPercent(board.timer, T0 + 30_000)).toBe(25)
    expect(timerRemaining(board.timer, T0 + 10 * 60_000)).toBe(0)
    expect(timerPercent(board.timer, T0 + 10 * 60_000)).toBe(100)
    expect(formatClock(90)).toBe("01:30")
  })

  test("stopping resets it, and the duration cannot change while it runs", () => {
    const running = startTimer(createBoard(), T0)
    expect(applySettings(running, { timerMinutes: 10 }).timer.durationSeconds).toBe(300)
    const stopped = stopTimer(running)
    expect(stopped.timer.endsAt).toBeNull()
    expect(timerRemaining(stopped.timer, T0 + 60_000)).toBe(300)
    expect(applySettings(stopped, { timerMinutes: 45 }).timer.durationSeconds).toBe(1800)
  })
})

describe("export and follow-up", () => {
  function finished(): Board {
    const voted = must(vote(must(vote(createBoard(), "note-3")), "note-1"))
    return must(convertToAction(voted, "note-3", "Priya", "2026-10-25"))
  }

  test("markdown lists every column with votes and actions with owners", () => {
    expect(exportMarkdown(finished(), "2026-10-18")).toBe(
      [
        "# Retro 2026-10-18",
        "## Went well\n\n- Deploys were smooth all sprint (+1)\n- Pairing on the parser rewrite",
        "## To improve\n\n- Flaky end-to-end tests slowed reviews (+1) → action\n- Standups run long\n- E2E suite fails randomly on CI",
        "## Actions\n\n- [ ] Flaky end-to-end tests slowed reviews — **Priya**, due 2026-10-25",
      ].join("\n\n"),
    )
  })

  test("the follow-up prompt needs actions and carries owners, dates and top problems", () => {
    expect(followUpPrompt(createBoard(), "2026-10-18")).toBeNull()
    const prompt = followUpPrompt(finished(), "2026-10-18") ?? ""
    expect(prompt).toContain("retro on 2026-10-18")
    expect(prompt).toContain("- Flaky end-to-end tests slowed reviews (owner Priya, due 2026-10-25)")
    expect(prompt).toContain("Most-voted problems for context:\n- Flaky end-to-end tests slowed reviews (1 vote)")
  })
})
