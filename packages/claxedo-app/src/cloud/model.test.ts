import { expect, test } from "bun:test"
import { canStart, canStop, cloudWorkspaceTransition } from "./model"

test("a provisioning workspace offers Stop only; Start is for an asleep or failed one", () => {
  const provisioning = { kind: "provisioning", step: "cloning" } as const
  expect(canStart(provisioning)).toBe(false)
  expect(canStop(provisioning)).toBe(true)
  expect(cloudWorkspaceTransition(provisioning, { type: "stopRequested" })).toEqual({ kind: "stopping" })
  expect(canStart({ kind: "stopped" })).toBe(true)
  expect(canStart({ kind: "failed", reason: "boot failed" })).toBe(true)
  expect(cloudWorkspaceTransition({ kind: "stopped" }, { type: "startRequested" })).toEqual({ kind: "starting" })
  expect(canStart({ kind: "ready" })).toBe(false)
})
