import type { AgentPresentationEvent } from "@claxedo/agent-runtime-contract"
import { describe, expect, test } from "bun:test"
import { createHarnessHealthFeed, type SessionHarnessHealth } from "./harness-health-feed"

const OK: SessionHarnessHealth = { harnessHealth: { status: "ok" } }
const LOST: SessionHarnessHealth = { harnessHealth: { status: "degraded", reason: "harness_process_lost", message: "exited" } }

function feedOver(health: Map<string, SessionHarnessHealth>) {
  const published: { directory: string; event: Extract<AgentPresentationEvent, { type: "harness.health" }>["properties"] }[] = []
  const reads: string[] = []
  const feed = createHarnessHealthFeed({
    read: async (sessionId) => {
      reads.push(sessionId)
      return health.get(sessionId) ?? OK
    },
    publish: (directory, event) => published.push({ directory, event }),
    onReadFailure: () => {},
  })
  return { feed, published, reads }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

describe("harness health feed", () => {
  test("a turn's start publishes the session's health once, and an unchanged read publishes nothing", async () => {
    const { feed, published } = feedOver(new Map())
    feed.turnStarted("s1", "/w")
    await settle()
    feed.changed()
    await settle()
    expect(published).toEqual([{ directory: "/w", event: { sessionID: "s1", harnessHealth: { status: "ok" } } }])
  })

  test("a reported change during a turn publishes the lost process, and its recovery publishes ok", async () => {
    const health = new Map<string, SessionHarnessHealth>()
    const { feed, published } = feedOver(health)
    feed.turnStarted("s1", "/w")
    await settle()
    health.set("s1", LOST)
    feed.changed()
    await settle()
    health.set("s1", OK)
    feed.changed()
    await settle()
    expect(published.map((row) => row.event.harnessHealth.status)).toEqual(["ok", "degraded", "ok"])
  })

  test("a session is read once after its turn ends, then no longer", async () => {
    const health = new Map<string, SessionHarnessHealth>()
    const { feed, published, reads } = feedOver(health)
    feed.turnStarted("s1", "/w")
    await settle()
    health.set("s1", { harnessHealth: { status: "ok" }, connectionState: { connectionId: "c1", state: "disconnected", processes: [] } })
    feed.turnEnded("s1")
    await settle()
    feed.changed()
    await settle()
    expect(reads).toEqual(["s1", "s1"])
    expect(published.at(-1)?.event.connectionState?.state).toBe("disconnected")
  })

  test("several triggers in one task read each watched session once", async () => {
    const { feed, reads } = feedOver(new Map())
    feed.turnStarted("s1", "/w")
    feed.turnStarted("s2", "/w")
    feed.changed()
    feed.changed()
    await settle()
    expect(reads.sort()).toEqual(["s1", "s2"])
  })

  test("a read answered after a newer one is dropped", async () => {
    const answers: ((value: SessionHarnessHealth) => void)[] = []
    const published: Extract<AgentPresentationEvent, { type: "harness.health" }>["properties"][] = []
    const feed = createHarnessHealthFeed({
      read: () => new Promise((resolve) => answers.push(resolve)),
      publish: (_directory, event) => published.push(event),
      onReadFailure: () => {},
    })
    feed.turnStarted("s1", "/w")
    await settle()
    feed.changed()
    await settle()
    answers[1]?.(LOST)
    answers[0]?.(OK)
    await settle()
    expect(published.map((event) => event.harnessHealth.status)).toEqual(["degraded"])
  })

  test("a failed read is reported and publishes nothing", async () => {
    const failures: string[] = []
    const published: unknown[] = []
    const feed = createHarnessHealthFeed({
      read: async () => {
        throw new Error("store closed")
      },
      publish: (_directory, event) => published.push(event),
      onReadFailure: (sessionId) => failures.push(sessionId),
    })
    feed.turnStarted("s1", "/w")
    await settle()
    expect({ failures, published }).toEqual({ failures: ["s1"], published: [] })
  })

  test("a disposed feed reads nothing", async () => {
    const { feed, reads } = feedOver(new Map())
    feed.turnStarted("s1", "/w")
    feed.dispose()
    await settle()
    expect(reads).toEqual([])
  })
})
