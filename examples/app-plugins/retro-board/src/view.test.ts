import { describe, expect, test } from "bun:test"
import { applySettings, convertToAction, createBoard, toggleSelected, vote, type Board, type Change } from "./model"
import { columnSection, columnsData, noticeMessages, retroComponents, settingsData, summaryData, votesData } from "./view"

function must(change: Change): Board {
  if (change.error) throw new Error(change.error)
  return change.board
}

describe("view data", () => {
  test("note rows carry a vote count with a tone that marks voted notes", () => {
    const board = must(vote(must(vote(createBoard(), "note-3")), "note-3"))
    const [voted, plain] = columnsData(board).improve ?? []
    expect(voted).toMatchObject({ id: "note-3", votesLabel: "2 votes", votesTone: "accent", meta: "" })
    expect(plain).toMatchObject({ votesLabel: "0 votes", votesTone: "neutral" })
  })

  test("a note row shows Vote and keeps selection behind an icon whose label says what it does", () => {
    const byId = new Map(retroComponents(createBoard()).map((component) => [component.id, component]))
    expect(byId.get("note-well")).toMatchObject({ primaryAction: "note-vote", actions: ["note-select"] })
    expect(byId.get("note-select")).toMatchObject({ component: "Button", icon: "check" })
    expect(byId.get("note-remove")).toMatchObject({ component: "Button", icon: "delete" })
    const selected = columnsData(must(toggleSelected(createBoard(), "note-3"))).improve?.[0]
    expect(selected).toMatchObject({ id: "note-3", selected: true, selectLabel: "Deselect “Flaky end-to-end tests slowed r…” to merge" })
  })

  test("a column offers Merge selected only while one of its notes is selected", () => {
    expect("actions" in columnSection("improve", false)).toBe(false)
    expect(columnSection("improve", true)).toMatchObject({ actions: ["col-improve-merge"] })
  })

  test("the vote badge turns to a warning when none are left", () => {
    expect(votesData(createBoard())).toEqual({ remaining: "3 of 3 votes left", tone: "accent" })
    let board = createBoard()
    for (let index = 0; index < 3; index += 1) board = must(vote(board, "note-1"))
    expect(votesData(board)).toEqual({ remaining: "0 of 3 votes left", tone: "warning" })
  })

  test("the summary counts notes, votes and actions with a caption for each", () => {
    const board = must(convertToAction(must(vote(createBoard(), "note-4")), "note-4", "Sam", "2026-10-30"))
    expect(summaryData(board)).toEqual({
      subtitle: "5 notes · 1 action · in the order added",
      notes: { value: "5", caption: "2 went well · 3 to improve" },
      votes: { value: "1", caption: "Top: Standups run long" },
      actions: { value: "1", caption: "Next due 2026-10-30" },
    })
    expect(summaryData(createBoard(false)).votes.caption).toBe("No votes yet")
  })

  test("settings are sent as picker choices", () => {
    expect(settingsData(applySettings(createBoard(), { maxVotes: 5, timerMinutes: 10 }))).toEqual({ maxVotes: ["5"], sortByVotes: false, timerMinutes: ["10"] })
  })

  test("a refusal adds one dismissible callout above the board and a success removes it", () => {
    const shown = noticeMessages("s", { title: "Vote not counted", text: "You have used all 3 votes." }, false)[1]
    if (!shown || !("updateComponents" in shown)) throw new Error("expected components")
    expect(shown.updateComponents.components[0]).toMatchObject({ id: "root", children: ["header", "kpis", "board-notice", "board", "facilitation", "wrap-up"] })
    expect(shown.updateComponents.components[1]).toMatchObject({ tone: "warning", dismissible: true })
    expect(noticeMessages("s", null, true)).toHaveLength(1)
    expect(noticeMessages("s", null, false)).toEqual([])
  })
})
