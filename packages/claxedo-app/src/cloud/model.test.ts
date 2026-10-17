import { expect, test } from "bun:test"
import { canStart, canStartFresh, canStop, cloudStatusReason, cloudWorkspaceTransition } from "./model"

test("a workspace whose checkpoint cannot be restored offers Start fresh in place of Start, which would be refused again", () => {
  const unusable = { kind: "failed", reason: "This workspace's saved files expired after 30 days unused; choose Start fresh.", checkpointUnusable: true } as const
  expect(canStartFresh(unusable)).toBe(true)
  expect(canStart(unusable)).toBe(false)
  expect(canStartFresh({ kind: "failed", reason: "boot failed" })).toBe(false)
  expect(canStartFresh({ kind: "stopped" })).toBe(false)
  expect(cloudWorkspaceTransition(unusable, { type: "startRequested" })).toBe(unusable)
  expect(cloudWorkspaceTransition(unusable, { type: "startFreshRequested" })).toEqual({ kind: "starting" })
})

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

test("a workspace row says why it failed, or why the server stopped it, and nothing for one a person or idleness stopped", () => {
  expect(cloudStatusReason({ kind: "failed", reason: "boot failed" })).toBe("boot failed")
  expect(cloudStatusReason({ kind: "stopped", reason: "The workspace's runtime stopped answering; it was stopped after 10 minutes." })).toBe("The workspace's runtime stopped answering; it was stopped after 10 minutes.")
  expect(cloudStatusReason({ kind: "stopped" })).toBeUndefined()
  expect(cloudStatusReason({ kind: "ready" })).toBeUndefined()
})
