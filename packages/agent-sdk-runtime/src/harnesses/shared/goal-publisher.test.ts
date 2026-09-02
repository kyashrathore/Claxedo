import { describe, expect, test } from "bun:test"
import type { RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import type { RuntimeEventEnvelopeInput } from "../../runtime-event-hub"
import { createGoalPublisher } from "./goal-publisher"

/**
 * The Goal publication policy every adapter shares. These assertions are the
 * contract: dedupe by snapshot, mirror adapter state ONLY on an accepted
 * change, and emit goal-updated / goal-cleared from the same place.
 */
function harness() {
  const published: RuntimeEventEnvelopeInput[] = []
  return {
    published,
    publisher: createGoalPublisher({ publishRuntime: (event) => void published.push(event) }),
  }
}

function goal(overrides: Partial<RuntimeGoalSnapshot> = {}): RuntimeGoalSnapshot {
  return {
    sessionId: "session-1",
    objective: "Ship the publisher",
    status: "active",
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  }
}

describe("createGoalPublisher", () => {
  test("publishes a goal-updated envelope carrying the directory and agent session", () => {
    const { publisher, published } = harness()

    publisher.publish({
      sessionId: "session-1",
      directory: "/repo",
      agentSessionId: "thread-1",
      goal: goal(),
    })

    expect(published).toEqual([{
      directory: "/repo",
      sessionId: "session-1",
      agentSessionId: "thread-1",
      payload: { type: "goal-updated", sessionId: "session-1", goal: goal() },
    }])
  })

  test("omits agentSessionId entirely when the adapter has none", () => {
    const { publisher, published } = harness()

    publisher.publish({ sessionId: "session-1", directory: "/repo", goal: goal() })

    expect(published[0]).not.toHaveProperty("agentSessionId")
  })

  test("publishes goal-cleared for a null snapshot", () => {
    const { publisher, published } = harness()

    publisher.publish({ sessionId: "session-1", directory: "/repo", goal: null })

    expect(published.map((event) => event.payload)).toEqual([
      { type: "goal-cleared", sessionId: "session-1" },
    ])
  })

  test("dedupes an unchanged snapshot and republishes once it changes", () => {
    const { publisher, published } = harness()

    publisher.publish({ sessionId: "session-1", directory: "/repo", goal: goal() })
    publisher.publish({ sessionId: "session-1", directory: "/repo", goal: goal() })
    publisher.publish({ sessionId: "session-1", directory: "/repo", goal: goal({ status: "complete" }) })

    expect(published.map((event) => (event.payload as { goal?: RuntimeGoalSnapshot }).goal?.status))
      .toEqual(["active", "complete"])
  })

  test("dedupes per session, so equal snapshots from two sessions both publish", () => {
    const { publisher, published } = harness()

    publisher.publish({ sessionId: "session-1", directory: "/repo", goal: goal() })
    publisher.publish({ sessionId: "session-2", directory: "/repo", goal: goal() })

    expect(published.map((event) => event.sessionId)).toEqual(["session-1", "session-2"])
  })

  test("runs applyState only on an accepted change, before the event goes out", () => {
    const order: string[] = []
    const published: RuntimeEventEnvelopeInput[] = []
    const publisher = createGoalPublisher({
      publishRuntime: (event) => {
        order.push("publish")
        published.push(event)
      },
    })
    const applyState = (next: RuntimeGoalSnapshot | null) => order.push(`apply:${next?.status ?? "cleared"}`)

    publisher.publish({ sessionId: "session-1", directory: "/repo", goal: goal(), applyState })
    publisher.publish({ sessionId: "session-1", directory: "/repo", goal: goal(), applyState })
    publisher.publish({ sessionId: "session-1", directory: "/repo", goal: null, applyState })

    expect(order).toEqual(["apply:active", "publish", "apply:cleared", "publish"])
  })

  test("mirrors adapter state even when no event hub is wired", () => {
    const publisher = createGoalPublisher()
    const applied: Array<RuntimeGoalSnapshot | null> = []

    publisher.publish({
      sessionId: "session-1",
      directory: "/repo",
      goal: goal(),
      applyState: (next) => void applied.push(next),
    })

    expect(applied).toEqual([goal()])
  })

  test("forget retires the dedup entry so a re-created session republishes", () => {
    const { publisher, published } = harness()

    publisher.publish({ sessionId: "session-1", directory: "/repo", goal: goal() })
    publisher.forget("session-1")
    publisher.publish({ sessionId: "session-1", directory: "/repo", goal: goal() })

    expect(published).toHaveLength(2)
  })
})
