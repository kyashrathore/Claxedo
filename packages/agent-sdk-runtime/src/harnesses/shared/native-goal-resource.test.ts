import { describe, expect, test } from "bun:test"
import { goalActionAvailable, goalCapabilities, type GoalCapabilities } from "../../capabilities"
import { createNativeGoalResource, type NativeGoal, type NativeGoalResourceHost } from "./native-goal-resource"

function resource(input: {
  capabilities: GoalCapabilities
  hasLiveGoal?: boolean
  canDelete?: boolean
}) {
  const native = {
    capabilities: () => input.capabilities,
    read: async () => (input.hasLiveGoal ? { sessionId: "session-1", objective: "ship", status: "active" } : null),
    run: async () => {},
    stop: async () => {},
    ...(input.canDelete === false ? {} : { delete: async () => true }),
  } as unknown as NativeGoal
  return createNativeGoalResource({
    native,
    driverType: "cursor",
    lifecycle: () => ({}) as never,
    projectedGoal: () => null,
    publishGoal() {},
    sessionConfig: async () => ({}) as never,
    defaultModelId: () => "default",
    streamTurn: () => ({ async *[Symbol.asyncIterator]() {} }) as never,
  } satisfies NativeGoalResourceHost)
}

describe("native Goal resource capabilities", () => {
  test("adds delete for an available driver that can clear the Goal", async () => {
    const capabilities = await resource({
      capabilities: goalCapabilities({
        implemented: true,
        available: true,
        actions: [],
        recovery: "reconcile",
        optionalFields: [],
      }),
      hasLiveGoal: true,
    }).readCapabilities("session-1", "/repo")

    expect(capabilities.actions).toEqual(["delete"])
    expect(goalActionAvailable(capabilities, "delete")).toBe(true)
  })

  // An unavailable capability is denied every action by `goalActionAvailable`,
  // so widening its `actions` would publish a choice the same contract refuses.
  // The Cursor SDK without a key is the live example: Tier R reads this exact
  // body from `GET /session/:id/goal/capabilities`.
  test("an unavailable driver advertises no action it could not honor", async () => {
    const capabilities = await resource({
      capabilities: goalCapabilities({
        implemented: true,
        available: false,
        unavailableReason: "Cursor SDK requires an explicit cursor-sdk API key.",
        actions: [],
        recovery: "blocked",
        optionalFields: [],
      }),
      hasLiveGoal: false,
    }).readCapabilities("session-1", "/repo")

    expect(capabilities.actions).toEqual([])
    expect(goalActionAvailable(capabilities, "delete")).toBe(false)
  })
})
