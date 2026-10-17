import { expect, test } from "bun:test"
import { isOrgManager, sessionControls } from "./model"

test("a share holder never owns the session and a follow share never sends", () => {
  expect(sessionControls(undefined)).toEqual({ owner: true, send: true })
  expect(sessionControls("send")).toEqual({ owner: false, send: true })
  expect(sessionControls("follow")).toEqual({ owner: false, send: false })
})

test("the organization's team-key spend is an owner's or admin's to see; a member or no membership is denied", () => {
  expect(isOrgManager("owner")).toBe(true)
  expect(isOrgManager("admin")).toBe(true)
  expect(isOrgManager("member")).toBe(false)
  expect(isOrgManager(undefined)).toBe(false)
})
