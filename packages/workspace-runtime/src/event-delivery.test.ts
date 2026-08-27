import { describe, expect, test } from "bun:test"
import { createBus } from "./bus"
import {
  createIdentityAwareEventSource,
  type EventDeliveryPrincipal,
  type EventDeliveryPolicy,
} from "./event-delivery"

type Event = { sessionId: string; value: string }

const participant = (connectionId: string): Extract<EventDeliveryPrincipal, { mode: "verified" }> => ({
  mode: "verified",
  connectionId,
  actorId: "actor_participant",
  actorKind: "human",
  orgId: "org_1",
  workspaceId: "ws_1",
  role: "editor",
})

const nonparticipant = (connectionId: string): Extract<EventDeliveryPrincipal, { mode: "verified" }> => ({
  mode: "verified",
  connectionId,
  actorId: "actor_workspace_only",
  actorKind: "human",
  orgId: "org_1",
  workspaceId: "ws_1",
  role: "editor",
})

describe("createIdentityAwareEventSource", () => {
  test("bounds replay authorization concurrency while preserving event order", async () => {
    const bus = createBus<Event>()
    let active = 0
    let maximum = 0
    const policy: EventDeliveryPolicy<Event> = async () => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return "deliver" as const
    }
    const source = createIdentityAwareEventSource({ subscribe: bus.subscribe, policy, sessionId: (event) => event.sessionId })
    for (let index = 0; index < 24; index += 1) {
      bus.publish({ sessionId: `ses_${index}`, value: `event_${index}` })
    }
    const opened = source.open(participant("replay_connection"))
    await opened.ready
    expect(maximum).toBeLessThanOrEqual(8)
    expect(opened.replay.replayAfter("0").map((entry) => entry.payload.value))
      .toEqual(Array.from({ length: 24 }, (_, index) => `event_${index}`))
    source.close()
  })

  test("terminates an overflowed stream instead of growing an unbounded authority queue", async () => {
    const bus = createBus<Event>()
    const policy: EventDeliveryPolicy<Event> = () => new Promise(() => {})
    const source = createIdentityAwareEventSource({ subscribe: bus.subscribe, policy, sessionId: (event) => event.sessionId })
    const opened = source.open(participant("slow_connection"))
    let terminated = false
    opened.subscribe(() => undefined, () => { terminated = true })
    for (let index = 0; index < 300; index += 1) {
      bus.publish({ sessionId: `ses_${index}`, value: `event_${index}` })
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(terminated).toBe(true)
    source.close()
  })

  test("bounds total replay startup time when authority never responds", async () => {
    const bus = createBus<Event>()
    const source = createIdentityAwareEventSource({
      subscribe: bus.subscribe,
      policy: () => new Promise(() => {}),
      sessionId: (event) => event.sessionId,
      replayStartupDeadlineMs: 20,
    })
    bus.publish({ sessionId: "ses_stuck", value: "stuck" })
    const startedAt = Date.now()
    const opened = source.open(participant("deadline_connection"))
    await opened.ready
    expect(Date.now() - startedAt).toBeLessThan(100)
    expect(opened.replay.lastId()).toBeUndefined()
    source.close()
  })

  test("uses per-principal replay ids so another identity's traffic cannot create a false gap", async () => {
    const bus = createBus<Event>()
    const policy: EventDeliveryPolicy<Event> = ({ principal, event }) =>
      principal.mode === "verified" && principal.actorId === "actor_participant" && event.sessionId === "ses_private"
        ? "deliver"
        : "omit"
    const source = createIdentityAwareEventSource({
      subscribe: bus.subscribe,
      policy,
      sessionId: (event) => event.sessionId,
    })

    const participantOpened = source.open(participant("connection_1"))
    participantOpened.subscribe(() => undefined)
    const participantReplay = participantOpened.replay
    source.open(nonparticipant("connection_2")).subscribe(() => undefined)
    for (let index = 0; index < 300; index += 1) {
      bus.publish({ sessionId: "ses_other", value: `other_${index}` })
    }
    bus.publish({ sessionId: "ses_private", value: "visible" })
    await source.flush()

    expect(participantReplay.lastId()).toBe("1")
    expect(participantReplay.hasGap("0", participantReplay.lastId())).toBe(false)
    expect(participantReplay.replayAfter("0").map((entry) => ({ id: entry.id, payload: entry.payload }))).toEqual([
      { id: "1", payload: { sessionId: "ses_private", value: "visible" } },
    ])
    expect(source.open(nonparticipant("connection_3")).replay.lastId()).toBeUndefined()
    source.close()
  })

  test("retains authorized events while disconnected and rechecks visibility on reconnect", async () => {
    const bus = createBus<Event>()
    const revoked = new Set<string>()
    const decisions: Array<{ actorId?: string; connectionId: string; value: string }> = []
    const source = createIdentityAwareEventSource({
      subscribe: bus.subscribe,
      policy: ({ principal, event }) => {
        decisions.push({
          actorId: principal.mode === "verified" ? principal.actorId : undefined,
          connectionId: principal.connectionId,
          value: event.value,
        })
        if (principal.mode !== "verified" || principal.actorId !== "actor_participant") return "omit"
        return revoked.has(principal.actorId) ? "terminate" : "deliver"
      },
      sessionId: (event) => event.sessionId,
    })

    const first = source.open(participant("connection_1"))
    const disconnect = first.subscribe(() => undefined)
    disconnect()
    bus.publish({ sessionId: "ses_private", value: "during_disconnect" })
    await source.flush()

    const reconnect = source.open(participant("connection_2"))
    await reconnect.ready
    expect(reconnect.replay.replayAfter("0").map((entry) => entry.payload.value)).toEqual(["during_disconnect"])
    expect(await reconnect.decide({ sessionId: "ses_private", value: "during_disconnect" })).toBe("deliver")

    revoked.add("actor_participant")
    expect(await reconnect.decide({ sessionId: "ses_private", value: "during_disconnect" })).toBe("terminate")
    expect(decisions.some((decision) => decision.connectionId === "connection_2")).toBe(true)
    source.close()
  })

  test("tears down already-open subscriptions when the policy returns terminate", async () => {
    const bus = createBus<Event>()
    let revoked = false
    const source = createIdentityAwareEventSource({
      subscribe: bus.subscribe,
      policy: () => revoked ? "terminate" : "deliver",
      sessionId: (event) => event.sessionId,
    })
    const opened = source.open(participant("connection_1"))
    const received: string[] = []
    let terminated = false
    const unsubscribe = opened.subscribe(
      (event) => received.push(event.value),
      () => {
        terminated = true
      },
    )

    bus.publish({ sessionId: "ses_private", value: "live" })
    await source.flush()
    revoked = true
    bus.publish({ sessionId: "ses_private", value: "revocation" })
    await source.flush()

    expect(received).toEqual(["live"])
    expect(terminated).toBe(true)
    unsubscribe()
    source.close()
  })

  test("authorizes simultaneous connections for one actor with their own credentials", async () => {
    const bus = createBus<Event>()
    const revoked = new Set<string>()
    const source = createIdentityAwareEventSource({
      subscribe: bus.subscribe,
      policy: ({ principal }) => {
        if (principal.mode !== "verified" || !principal.credential) return "terminate"
        return revoked.has(principal.credential) ? "terminate" : "deliver"
      },
      sessionId: (event) => event.sessionId,
    })
    const old = source.open({ ...participant("connection_old"), credential: "Bearer old" })
    const fresh = source.open({ ...participant("connection_fresh"), credential: "Bearer fresh" })
    const oldEvents: string[] = []
    const freshEvents: string[] = []
    let oldTerminated = false
    let freshTerminated = false
    old.subscribe((event) => oldEvents.push(event.value), () => {
      oldTerminated = true
    })
    fresh.subscribe((event) => freshEvents.push(event.value), () => {
      freshTerminated = true
    })

    bus.publish({ sessionId: "ses_private", value: "before_revocation" })
    await source.flush()
    revoked.add("Bearer old")
    bus.publish({ sessionId: "ses_private", value: "after_revocation" })
    await source.flush()

    expect(oldEvents).toEqual(["before_revocation"])
    expect(freshEvents).toEqual(["before_revocation", "after_revocation"])
    expect(oldTerminated).toBe(true)
    expect(freshTerminated).toBe(false)
    source.close()
  })

  test("evicts disconnected scopes and reconstructs replay from bounded retention", async () => {
    const bus = createBus<Event>()
    const decisions: string[] = []
    const source = createIdentityAwareEventSource({
      subscribe: bus.subscribe,
      policy: ({ event }) => {
        decisions.push(event.value)
        return "deliver"
      },
      sessionId: (event) => event.sessionId,
    })
    const first = source.open(participant("connection_1"))
    await first.ready
    const unsubscribe = first.subscribe(() => undefined)
    bus.publish({ sessionId: "ses_private", value: "connected" })
    await source.flush()
    unsubscribe()

    const callsBeforeGap = decisions.length
    bus.publish({ sessionId: "ses_private", value: "during_gap" })
    await source.flush()
    expect(decisions).toHaveLength(callsBeforeGap)

    const reconnect = source.open(participant("connection_2"))
    await reconnect.ready
    expect(reconnect.replay.replayAfter("1").map((entry) => entry.payload.value)).toEqual(["during_gap"])
    expect(decisions.length).toBeGreaterThan(callsBeforeGap)
    source.close()
  })
})
