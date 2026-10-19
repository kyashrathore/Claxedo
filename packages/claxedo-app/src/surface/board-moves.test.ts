/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import { boardGrabTransition, boardKeyAction, grabbedMove, isMoveToElsewhere, pointerDropIndex, type BoardGrab, type BoardGrabEvent, type BoardLayout } from "./board-moves"

const layout: BoardLayout = [
  { key: "todo", ids: ["a", "b", "c"] },
  { key: "doing", ids: ["d"] },
  { key: "done", ids: [] },
]

function run(events: readonly BoardGrabEvent[], from: BoardGrab = { kind: "idle" }): BoardGrab {
  return events.reduce(boardGrabTransition, from)
}

const step = (direction: "up" | "down" | "left" | "right"): BoardGrabEvent => ({ type: "stepped", step: direction, layout })

describe("the keyboard grab machine", () => {
  test("idle → grabbed on a grab, and back to idle on a drop or a cancel", () => {
    const grabbed = run([{ type: "grabbed", itemId: "b", from: { column: "todo", index: 1 } }])
    expect(grabbed).toEqual({ kind: "grabbed", itemId: "b", from: { column: "todo", index: 1 }, at: { column: "todo", index: 1 } })
    expect(boardGrabTransition(grabbed, { type: "dropped" })).toEqual({ kind: "idle" })
    expect(boardGrabTransition(grabbed, { type: "cancelled" })).toEqual({ kind: "idle" })
  })

  test("a step while idle and a second grab change nothing", () => {
    expect(run([step("down")])).toEqual({ kind: "idle" })
    const grabbed = run([{ type: "grabbed", itemId: "b", from: { column: "todo", index: 1 } }])
    expect(boardGrabTransition(grabbed, { type: "grabbed", itemId: "c", from: { column: "todo", index: 2 } })).toBe(grabbed)
  })

  test("up and down move within the column and stop at its ends, counting the column without the grabbed item", () => {
    const grab: BoardGrabEvent = { type: "grabbed", itemId: "b", from: { column: "todo", index: 1 } }
    expect(grabbedMove(run([grab, step("down"), step("down"), step("down")]))).toEqual({ itemId: "b", fromColumn: "todo", fromIndex: 1, toColumn: "todo", toIndex: 2 })
    expect(grabbedMove(run([grab, step("up"), step("up")]))).toEqual({ itemId: "b", fromColumn: "todo", fromIndex: 1, toColumn: "todo", toIndex: 0 })
  })

  test("left and right move across columns, keep the position where it fits and stop at the outer columns", () => {
    const grab: BoardGrabEvent = { type: "grabbed", itemId: "c", from: { column: "todo", index: 2 } }
    expect(grabbedMove(run([grab, step("right")]))).toMatchObject({ toColumn: "doing", toIndex: 1 })
    expect(grabbedMove(run([grab, step("right"), step("right"), step("right")]))).toMatchObject({ toColumn: "done", toIndex: 0 })
    expect(grabbedMove(run([grab, step("left")]))).toMatchObject({ toColumn: "todo", toIndex: 2 })
  })

  test("a move back to where it started is not a move", () => {
    const grab: BoardGrabEvent = { type: "grabbed", itemId: "b", from: { column: "todo", index: 1 } }
    const state = run([grab, step("down"), step("up")])
    const move = grabbedMove(state)
    expect(move && isMoveToElsewhere(move)).toBe(false)
    expect(grabbedMove({ kind: "idle" })).toBeUndefined()
  })
})

describe("boardKeyAction", () => {
  test("Space and Enter grab or drop; arrows and Escape act only while grabbed", () => {
    expect([" ", "Enter"].map((key) => boardKeyAction(key, false))).toEqual([{ kind: "toggle" }, { kind: "toggle" }])
    expect(["ArrowUp", "Escape", "a"].map((key) => boardKeyAction(key, false))).toEqual([{ kind: "none" }, { kind: "none" }, { kind: "none" }])
    expect(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Escape", "Tab"].map((key) => boardKeyAction(key, true))).toEqual([
      { kind: "step", step: "up" },
      { kind: "step", step: "down" },
      { kind: "step", step: "left" },
      { kind: "step", step: "right" },
      { kind: "cancel" },
      { kind: "none" },
    ])
  })
})

describe("pointerDropIndex", () => {
  test("drops before the first item whose middle is below the pointer", () => {
    expect([0, 25, 75, 300].map((y) => pointerDropIndex([20, 60, 100], y))).toEqual([0, 1, 2, 3])
    expect(pointerDropIndex([], 40)).toBe(0)
  })
})
