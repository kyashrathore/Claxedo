/// <reference types="bun" />
import { expect, test } from "bun:test"
import { gonePlacementsNotice } from "./gone-placements-notice"

test("gone placements: the routed workspace that is gone is the one the notice names", () => {
  expect(gonePlacementsNotice({ closedTabs: 1, routedGone: true })).toBe("shell.home.placementGone")
  expect(gonePlacementsNotice({ closedTabs: 0, routedGone: true })).toBe("shell.home.placementGone")
})

test("gone placements: tabs closed behind a workspace that still exists never read as that workspace being gone", () => {
  expect(gonePlacementsNotice({ closedTabs: 2, routedGone: false })).toBe("shell.home.goneTabsClosed")
})

test("gone placements: nothing closed says nothing", () => {
  expect(gonePlacementsNotice({ closedTabs: 0, routedGone: false })).toBeUndefined()
})
