import { expect, test } from "bun:test"
import type { SessionBroker } from "../../contract"
import { activeGoal, goalSessionStore, transcriptGoal } from "./goal-state"

test("Claude active_goal carries the SDK objective, iteration and timestamp", () => {
  const goal = activeGoal("s1", { type: "active_goal", value: { condition: "Ship", iterations: 3,
    set_at: 1_700_000_000, tokens_at_start: 0, last_reason: "Continue" }, uuid: "00000000-0000-0000-0000-000000000001", session_id: "up1" })
  expect(goal).toMatchObject({ sessionId: "s1", objective: "Ship", status: "active", createdAt: 1_700_000_000_000,
    iteration: 3, lastReason: "Continue" })
})

test("goal_status transcript entries advance and clear the native goal", () => {
  const entry = { type: "attachment", timestamp: "2026-09-25T10:00:00Z", attachment: {
    type: "goal_status", met: false, condition: "Ship", reason: "More work", iterations: 2,
  } }
  const first = transcriptGoal("s1", entry, null)
  expect(first).toMatchObject({ objective: "Ship", status: "active", iteration: 2, lastReason: "More work" })
  expect(transcriptGoal("s1", { ...entry, attachment: { type: "goal_status", met: true } }, first ?? null)).toBeNull()
  expect(transcriptGoal("s1", { type: "attachment", attachment: { type: "other" } }, first ?? null)).toBeUndefined()
})

test("a title mirrored outside a turn publishes through the session broker", async () => {
  const published: unknown[] = []
  const broker = { sessionId: "s1", goal: { read: () => null, publish: async () => {} },
    publish: async (event: unknown) => { published.push(event) } } as unknown as SessionBroker
  await goalSessionStore(broker, new AbortController().signal).append({ projectKey: "p", sessionId: "up1" }, [
    { type: "ai-title", aiTitle: "Named by Claude" },
  ])
  expect(published).toMatchObject([{ type: "session-title", title: "Named by Claude" }])
})
