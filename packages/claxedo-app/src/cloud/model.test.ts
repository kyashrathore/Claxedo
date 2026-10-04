import { expect, test } from "bun:test"
import { canStart, cloudWorkspaceTransition } from "./model"

test("interrupted provisioning can continue through an explicit start", () => {
  const state = { kind: "provisioning", step: "booting" } as const
  expect(canStart(state)).toBe(true)
  expect(cloudWorkspaceTransition(state, { type: "startRequested" })).toEqual({ kind: "starting" })
  expect(canStart({ kind: "starting" })).toBe(false)
  expect(canStart({ kind: "ready" })).toBe(false)
})
