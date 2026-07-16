import { expect, test, vi } from "vitest"
import { createNodeSettlementDispatcher, noopSettlementDispatcher } from "./settlement-dispatcher"

test("serializes settlement runs for the same tenant", async () => {
  const firstStarted = Promise.withResolvers<void>()
  const releaseFirst = Promise.withResolvers<void>()
  const secondStarted = Promise.withResolvers<void>()
  let running = 0
  let maxRunning = 0
  const settle = vi.fn(async () => {
    running += 1
    maxRunning = Math.max(maxRunning, running)
    if (settle.mock.calls.length === 1) {
      firstStarted.resolve()
      await releaseFirst.promise
    } else {
      secondStarted.resolve()
    }
    running -= 1
  })
  const dispatcher = createNodeSettlementDispatcher({ settle })
  const tenant = { organizationId: "org_1", ownerUserId: "user_1" }

  dispatcher.nudge(tenant)
  await firstStarted.promise
  dispatcher.nudge(tenant)
  await Promise.resolve()

  expect(settle).toHaveBeenCalledTimes(1)
  expect(maxRunning).toBe(1)

  releaseFirst.resolve()
  await secondStarted.promise
  expect(settle).toHaveBeenCalledTimes(2)
  expect(maxRunning).toBe(1)
})

test("runs settlement for different tenants in parallel", async () => {
  const bothStarted = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const started = new Set<string>()
  const settle = vi.fn(async (tenant: { organizationId: string; ownerUserId: string }) => {
    started.add(tenant.ownerUserId)
    if (started.size === 2) bothStarted.resolve()
    await release.promise
  })
  const dispatcher = createNodeSettlementDispatcher({ settle })

  dispatcher.nudge({ organizationId: "org_1", ownerUserId: "user_1" })
  dispatcher.nudge({ organizationId: "org_1", ownerUserId: "user_2" })
  await bothStarted.promise

  expect(started).toEqual(new Set(["user_1", "user_2"]))
  expect(settle).toHaveBeenCalledTimes(2)

  release.resolve()
})

test("coalesces a burst of nudges into at most one queued run", async () => {
  const firstStarted = Promise.withResolvers<void>()
  const releaseFirst = Promise.withResolvers<void>()
  const queuedStarted = Promise.withResolvers<void>()
  const settle = vi.fn(async () => {
    if (settle.mock.calls.length === 1) {
      firstStarted.resolve()
      await releaseFirst.promise
      return
    }
    queuedStarted.resolve()
  })
  const dispatcher = createNodeSettlementDispatcher({ settle })
  const tenant = { organizationId: "org_1", ownerUserId: "user_1" }

  dispatcher.nudge(tenant)
  await firstStarted.promise
  dispatcher.nudge(tenant)
  dispatcher.nudge(tenant)
  dispatcher.nudge(tenant)
  dispatcher.nudge(tenant)

  expect(settle).toHaveBeenCalledTimes(1)

  releaseFirst.resolve()
  await queuedStarted.promise
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(settle).toHaveBeenCalledTimes(2)
})

test("reports settlement errors without throwing or blocking later runs", async () => {
  const error = new Error("settlement failed")
  const reported = Promise.withResolvers<unknown>()
  const recovered = Promise.withResolvers<void>()
  const settle = vi.fn()
    .mockRejectedValueOnce(error)
    .mockImplementationOnce(() => recovered.resolve())
  const reportError = vi.fn((reportedError: unknown) => reported.resolve(reportedError))
  const dispatcher = createNodeSettlementDispatcher({ settle, reportError })
  const tenant = { organizationId: "org_1", ownerUserId: "user_1" }

  expect(() => dispatcher.nudge(tenant)).not.toThrow()
  await expect(reported.promise).resolves.toBe(error)
  expect(reportError).toHaveBeenCalledWith(error, {
    tags: { source: "workgraph_settlement_dispatcher" },
  })

  expect(() => dispatcher.nudge(tenant)).not.toThrow()
  await recovered.promise
  expect(settle).toHaveBeenCalledTimes(2)
})

test("the no-op dispatcher accepts nudges", () => {
  expect(() => noopSettlementDispatcher.nudge({
    organizationId: "org_1",
    ownerUserId: "user_1",
  })).not.toThrow()
})

test("nudge returns before starting settlement work", async () => {
  const started = Promise.withResolvers<void>()
  const settle = vi.fn(() => started.resolve())
  const dispatcher = createNodeSettlementDispatcher({ settle })

  dispatcher.nudge({ organizationId: "org_1", ownerUserId: "user_1" })

  expect(settle).not.toHaveBeenCalled()
  await started.promise
})
