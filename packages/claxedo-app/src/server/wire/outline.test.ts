/// <reference types="bun" />
import { expect, test } from "bun:test"
import { outlineFromWire } from "./outline"

test("outline wire: turns keep their ids, times, title and prompt snippet; a malformed turn is dropped", () => {
  const outline = outlineFromWire({
    turns: [
      { id: "msg_1", createdAt: 10, title: "First", user: "why?" },
      { id: "msg_2", createdAt: "soon" },
      { createdAt: 30 },
      null,
    ],
    complete: false,
  })
  expect(outline).toEqual({
    turns: [
      { id: "msg_1", createdAt: 10, title: "First", preview: { user: "why?" } },
      { id: "msg_2", createdAt: 0, preview: {} },
    ],
    complete: false,
  })
})

test("outline wire: a body without a list of turns is a server error", () => {
  expect(() => outlineFromWire({ complete: true })).toThrow("The turn outline is not a list of turns")
  expect(() => outlineFromWire([])).toThrow("The turn outline is not a list of turns")
})

test("outline wire: an outline the control plane denies is no outline, not an empty complete one", () => {
  expect(outlineFromWire({ allowed: false, turns: [], complete: true })).toBeUndefined()
  expect(outlineFromWire({ allowed: true, turns: [], complete: true })).toEqual({ turns: [], complete: true })
})
