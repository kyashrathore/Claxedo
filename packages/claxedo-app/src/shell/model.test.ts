/// <reference types="bun" />
import { expect, test } from "bun:test"
import { transitionShellLayout, type ShellLayoutState } from "./model"

const wide: ShellLayoutState = { kind: "wide", sidebar: "open", panel: "open" }
const phone: ShellLayoutState = { kind: "phone", drawer: "closed", sheet: "closed" }

test("shell layout: an event that changes no region returns the same state", () => {
  expect(transitionShellLayout(wide, { type: "showPanel" })).toBe(wide)
  expect(transitionShellLayout(wide, { type: "showSidebar" })).toBe(wide)
  expect(transitionShellLayout(phone, { type: "navigated" })).toBe(phone)
  expect(transitionShellLayout(phone, { type: "hidePanel" })).toBe(phone)
})

test("shell layout: an event that changes a region returns the changed state", () => {
  expect(transitionShellLayout(wide, { type: "hidePanel" })).toEqual({ kind: "wide", sidebar: "open", panel: "collapsed" })
  expect(transitionShellLayout(phone, { type: "showPanel" })).toEqual({ kind: "phone", drawer: "closed", sheet: "open" })
})
