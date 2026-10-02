import { expect, test } from "bun:test"
import { sessionControls } from "./model"

test("follow displays a read-only composer and neither sharing level offers owner actions", () => {
  expect(sessionControls({ owned: false, level: "follow" })).toEqual({ available: true, send: false, manage: false, shared: true })
  expect(sessionControls({ owned: false, level: "send" })).toEqual({ available: true, send: true, manage: false, shared: true })
  expect(sessionControls({ owned: false })).toEqual({ available: false, send: false, manage: false, shared: false })
  expect(sessionControls({ owned: true })).toEqual({ available: true, send: true, manage: true, shared: false })
})
