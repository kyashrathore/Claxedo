import { afterEach, describe, expect, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import { sessionGoalKey, type SessionGoalData } from "@/features/session/store/session-goal-cache"
import { dispatchGoalSubmit } from "./submit-goal"

const capabilities = {
  implemented: true,
  available: true,
  actions: ["pause", "resume", "delete"] as const,
  recovery: "reconcile" as const,
  optionalFields: [] as const,
}

const goal = {
  sessionId: "ses_goal",
  objective: "Ship Goal support",
  status: "active" as const,
  createdAt: 10,
  updatedAt: 10,
}

function createHarness(overrides: Record<string, unknown> = {}) {
  const order: string[] = []
  const input = {
    objective: goal.objective,
    session: { id: goal.sessionId },
    sessionDirectory: "/repo/main",
    client: {
      getGoalCapabilities: async () => {
        order.push("capabilities")
        return capabilities
      },
      startGoal: async () => {
        order.push("start")
        return { ok: true as const, status: "started" as const, goal }
      },
    },
    record: {
      saveSessionConfig: async () => { order.push("config") },
      onSubmit: () => { order.push("accepted") },
      capture: () => { order.push("capture") },
    },
    prepareLiveEvents: async () => { order.push("events") },
    clearInput: () => { order.push("clear-input") },
    restoreInput: () => { order.push("restore-input") },
    applyCreatedSessionHandoff: () => { order.push("handoff") },
    onAccepted: () => { order.push("disarm") },
    clearBoot: () => { order.push("clear-boot") },
    clearCloudStartup: () => { order.push("clear-cloud") },
    reportCloudStartupError: () => { order.push("cloud-error") },
    showFailed: () => { order.push("failed") },
    ...overrides,
  }
  return { input, order }
}

afterEach(() => queryClient.clear())

describe("Goal submit dispatch", () => {
  test("persists config then starts exactly one Goal without a prompt channel", async () => {
    const { input, order } = createHarness()

    await expect(dispatchGoalSubmit(input)).resolves.toBe(true)

    expect(order).toEqual([
      "events", "capabilities", "config", "start", "accepted", "capture",
      "clear-input", "disarm", "handoff", "clear-boot", "clear-cloud",
    ])
    expect(queryClient.getQueryData<SessionGoalData>(sessionGoalKey({
      sessionID: goal.sessionId,
      directory: "/repo/main",
    }))).toEqual({ capabilities, goal })
    expect("prompt" in input.client).toBe(false)
  })

  test("unavailable Goals preserve an explicit retry draft and hand off a created session", async () => {
    const { input, order } = createHarness({
      client: {
        getGoalCapabilities: async () => ({
          implemented: true,
          available: false,
          unavailableReason: "provider did not negotiate Goal",
          actions: [],
          recovery: "none",
          optionalFields: [],
        }),
        startGoal: async () => {
          order.push("unexpected-start")
          return { ok: true as const, status: "started" as const, goal }
        },
      },
    })

    await expect(dispatchGoalSubmit(input)).resolves.toBe(false)

    expect(order).toEqual(["events", "clear-boot", "cloud-error", "failed", "restore-input", "handoff"])
    expect(queryClient.getQueryData(sessionGoalKey({ sessionID: goal.sessionId, directory: "/repo/main" }))).toBeUndefined()
  })

  test("rejects a malformed success response instead of synthesizing Goal state", async () => {
    const { input, order } = createHarness({
      client: {
        getGoalCapabilities: async () => capabilities,
        startGoal: async () => ({ ok: true as const, status: "started" as const, goal: null }),
      },
    })

    await expect(dispatchGoalSubmit(input)).resolves.toBe(false)
    expect(order).toContain("restore-input")
    expect(order).not.toContain("clear-input")
  })
})
