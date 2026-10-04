import { expect, test } from "bun:test"
import { sessionControls } from "./model"

test("a share holder never owns the session and a follow share never sends", () => {
  expect(sessionControls(undefined)).toEqual({ owner: true, send: true })
  expect(sessionControls("send")).toEqual({ owner: false, send: true })
  expect(sessionControls("follow")).toEqual({ owner: false, send: false })
})
