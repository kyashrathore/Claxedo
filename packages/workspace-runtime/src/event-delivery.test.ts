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

/** Answers every policy question as it is asked, until none has been asked for a few turns. */
async function drain(release: Array<() => void>) {
  for (let idle = 0; idle < 5;) {
    if (release.length > 0) {
      while (release.length > 0) release.shift()!()
      idle = 0
    } else {
      idle += 1
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

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
    const source = createIdentityAwareEventSource<Event>({ subscribe: (fn) => bus.subscribe(fn), sequenceOrigin: () => 0, policy, sessionId: (event) => event.sessionId })
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
    const source = createIdentityAwareEventSource<Event>({ subscribe: (fn) => bus.subscribe(fn), sequenceOrigin: () => 0, policy, sessionId: (event) => event.sessionId })
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
    const source = createIdentityAwareEventSource<Event>({
      subscribe: (fn) => bus.subscribe(fn),
      sequenceOrigin: () => 0,
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
    const source = createIdentityAwareEventSource<Event>({
      subscribe: (fn) => bus.subscribe(fn),
      sequenceOrigin: () => 0,
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

  test("a frame published while a connection is opening is delivered once, under one id", async () => {
    const bus = createBus<Event>()
    const source = createIdentityAwareEventSource<Event>({
      subscribe: (fn) => bus.subscribe(fn),
      sequenceOrigin: () => 0,
      policy: () => "deliver",
      sessionId: (event) => event.sessionId,
    })
    // One credential, one scope. The scope is live: an attached connection
    // means every frame is decided and pushed into the scope's ring as it is
    // published.
    const credential = "Bearer rat_shared"
    const first = source.open({ ...participant("connection_1"), credential })
    const seenByFirst: string[] = []
    first.subscribe((event) => { seenByFirst.push(event.value) })
    bus.publish({ sessionId: "ses_a", value: "before" })
    await source.flush()

    // A second connection opens; a frame lands between its open and its
    // subscribe. Its catch-up over the retained ring must not decide that
    // frame a second time.
    const second = source.open({ ...participant("connection_2"), credential })
    bus.publish({ sessionId: "ses_a", value: "during-open" })
    await source.flush()
    const seenBySecond: string[] = []
    second.subscribe((event) => { seenBySecond.push(event.value) })
    await source.flush()

    expect(seenByFirst).toEqual(["before", "during-open"])
    expect(seenBySecond).toEqual([])
    const ring = second.replay.replayAfter(undefined).map((entry) => `${entry.id}:${entry.payload.value}`)
    expect(ring).toEqual(["1:before", "2:during-open"])
    source.close()
  })

  test("a frame still awaiting the policy when a second connection attaches reaches both connections once, under one id", async () => {
    const bus = createBus<Event>()
    // Every managed runtime's policy is asynchronous (the session authority
    // is awaited), so a frame's decision is pending when the next connection
    // attaches and catches up over the retained ring.
    const release: Array<() => void> = []
    const source = createIdentityAwareEventSource<Event>({
      subscribe: (fn) => bus.subscribe(fn),
      sequenceOrigin: () => 0,
      policy: () => new Promise<"deliver">((resolve) => { release.push(() => resolve("deliver")) }),
      sessionId: (event) => event.sessionId,
    })
    const credential = "Bearer rat_shared"
    const first = source.open({ ...participant("connection_1"), credential })
    const seenByFirst: string[] = []
    first.subscribe((event) => { seenByFirst.push(event.value) })
    bus.publish({ sessionId: "ses_a", value: "before" })
    release.shift()!()
    await source.flush()

    const second = source.open({ ...participant("connection_2"), credential })
    bus.publish({ sessionId: "ses_a", value: "during" })
    const seenBySecond: string[] = []
    second.subscribe((event) => { seenBySecond.push(event.value) })
    // Each decision the scope queues asks the policy afresh; answer them as
    // they are asked until the scope drains.
    await drain(release)
    await source.flush()

    expect(seenByFirst).toEqual(["before", "during"])
    expect(seenBySecond).toEqual(["during"])
    const ring = second.replay.replayAfter(undefined).map((entry) => `${entry.id}:${entry.payload.value}`)
    expect(ring).toEqual(["1:before", "2:during"])
    source.close()
  })

  test("a connection that attaches after a frame was published, while its decision is pending, is decided for it", async () => {
    const bus = createBus<Event>()
    const release: Array<() => void> = []
    const source = createIdentityAwareEventSource<Event>({
      subscribe: (fn) => bus.subscribe(fn),
      sequenceOrigin: () => 0,
      policy: () => new Promise<"deliver">((resolve) => { release.push(() => resolve("deliver")) }),
      sessionId: (event) => event.sessionId,
    })
    const credential = "Bearer rat_shared"
    const first = source.open({ ...participant("connection_1"), credential })
    const seenByFirst: string[] = []
    first.subscribe((event) => { seenByFirst.push(event.value) })
    // Published before the second connection even opens, so its catch-up over
    // the retained ring does not carry the frame; only the pending decision
    // can bring it to the second connection.
    bus.publish({ sessionId: "ses_a", value: "pending" })
    const second = source.open({ ...participant("connection_2"), credential })
    const seenBySecond: string[] = []
    second.subscribe((event) => { seenBySecond.push(event.value) })
    await drain(release)
    await source.flush()

    expect(seenByFirst).toEqual(["pending"])
    expect(seenBySecond).toEqual(["pending"])
    expect(second.replay.replayAfter(undefined).map((entry) => `${entry.id}:${entry.payload.value}`)).toEqual(["1:pending"])
    source.close()
  })

  test("a connection that attaches behind two pending frames receives them in ring order", async () => {
    const bus = createBus<Event>()
    const release: Array<() => void> = []
    const source = createIdentityAwareEventSource<Event>({
      subscribe: (fn) => bus.subscribe(fn),
      sequenceOrigin: () => 0,
      policy: () => new Promise<"deliver">((resolve) => { release.push(() => resolve("deliver")) }),
      sessionId: (event) => event.sessionId,
    })
    const credential = "Bearer rat_shared"
    const first = source.open({ ...participant("connection_1"), credential })
    const seenByFirst: string[] = []
    first.subscribe((event) => { seenByFirst.push(event.value) })
    bus.publish({ sessionId: "ses_a", value: "1" })
    bus.publish({ sessionId: "ses_a", value: "2" })
    const second = source.open({ ...participant("connection_2"), credential })
    const seenBySecond: string[] = []
    second.subscribe((event) => { seenBySecond.push(event.value) })
    await drain(release)
    await source.flush()

    expect(seenByFirst).toEqual(["1", "2"])
    expect(seenBySecond).toEqual(["1", "2"])
    expect(second.replay.replayAfter(undefined).map((entry) => `${entry.id}:${entry.payload.value}`)).toEqual(["1:1", "2:2"])
    source.close()
  })

  test("a scope restored from its tombstone after the retained ring rolled reports a gap instead of a contiguous hole", async () => {
    const bus = createBus<Event>()
    const source = createIdentityAwareEventSource<Event>({
      subscribe: (fn) => bus.subscribe(fn),
      sequenceOrigin: () => 0,
      policy: () => "deliver",
      sessionId: (event) => event.sessionId,
    })
    const credential = "Bearer rat_shared"
    const first = source.open({ ...participant("connection_1"), credential })
    const unsubscribe = first.subscribe(() => undefined)
    bus.publish({ sessionId: "ses_a", value: "1" })
    bus.publish({ sessionId: "ses_a", value: "2" })
    await source.flush()
    const cursor = first.replay.lastId()!
    unsubscribe()
    // More non-terminal frames than the retained ring keeps, while nobody is attached.
    for (let index = 0; index < 300; index += 1) bus.publish({ sessionId: "ses_a", value: `burst-${index}` })
    const restored = source.open({ ...participant("connection_2"), credential })
    await restored.ready
    expect(restored.replay.hasGap(cursor, restored.replay.lastId())).toBe(true)
    source.close()
  })

  test("a cursor issued by another process's ring lies below this ring's window and is a gap, whoever attached first", async () => {
    const bus = createBus<Event>()
    const source = createIdentityAwareEventSource<Event>({
      subscribe: (fn) => bus.subscribe(fn),
      policy: () => "deliver",
      sessionId: (event) => event.sessionId,
    })
    const credential = "Bearer rat_shared"
    // The previous process numbered this reader's ring 1, 2, 3 …; this one
    // numbers from the clock. Another tab already re-attached, so the scope
    // is not fresh — the numbering alone has to tell the old cursor apart.
    const first = source.open({ ...participant("connection_1"), credential })
    first.subscribe(() => undefined)
    bus.publish({ sessionId: "ses_a", value: "after-restart" })
    await source.flush()
    const second = source.open({ ...participant("connection_2"), credential })
    expect(second.replay.hasGap("300", second.replay.lastId())).toBe(true)
    expect(Number(second.replay.lastId())).toBeGreaterThan(300)
    source.close()
  })

  test("a cursor from a scope this process never held is a gap; a live scope's own cursor resumes", async () => {
    const bus = createBus<Event>()
    const source = createIdentityAwareEventSource<Event>({
      subscribe: (fn) => bus.subscribe(fn),
      sequenceOrigin: () => 0,
      policy: () => "deliver",
      sessionId: (event) => event.sessionId,
    })
    const first = source.open({ ...participant("connection_1"), credential: "Bearer rat_1" })
    first.subscribe(() => undefined)
    for (const value of ["a", "b", "c"]) bus.publish({ sessionId: "ses", value })
    await source.flush()
    // The same scope, still attached: its own numbering resumes.
    expect(first.replay.hasGap("2", first.replay.lastId())).toBe(false)
    expect(first.replay.replayAfter("2").map((entry) => entry.payload.value)).toEqual(["c"])

    // The relay re-minted the credential: a new scope, rebuilt from the retained
    // ring and numbered from 1. The reader's cursor "2" names a frame in the OLD
    // numbering, so it is a gap — not "replay c".
    const reminted = source.open({ ...participant("connection_2"), credential: "Bearer rat_2" })
    await reminted.ready
    expect(reminted.replay.hasGap("2", reminted.replay.lastId())).toBe(true)
    reminted.subscribe(() => undefined)
    bus.publish({ sessionId: "ses", value: "d" })
    await source.flush()
    // Once attached, the new scope's own numbering resumes.
    expect(reminted.replay.hasGap("3", reminted.replay.lastId())).toBe(false)
    expect(reminted.replay.replayAfter("3").map((entry) => entry.payload.value)).toEqual(["d"])
    source.close()
  })

  test("retains authorized events while disconnected and rechecks visibility on reconnect", async () => {
    const bus = createBus<Event>()
    const revoked = new Set<string>()
    const decisions: Array<{ actorId?: string; connectionId: string; value: string }> = []
    const source = createIdentityAwareEventSource<Event>({
      subscribe: (fn) => bus.subscribe(fn),
      sequenceOrigin: () => 0,
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
    const source = createIdentityAwareEventSource<Event>({
      subscribe: (fn) => bus.subscribe(fn),
      sequenceOrigin: () => 0,
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
    const source = createIdentityAwareEventSource<Event>({
      subscribe: (fn) => bus.subscribe(fn),
      sequenceOrigin: () => 0,
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

  test("does not expose another credential's replay to a revoked connection for the same actor", async () => {
    const bus = createBus<Event>()
    const revoked = new Set(["Bearer revoked"])
    const source = createIdentityAwareEventSource<Event>({
      subscribe: (fn) => bus.subscribe(fn),
      sequenceOrigin: () => 0,
      policy: ({ principal }) => {
        if (principal.mode !== "verified" || !principal.credential) return "terminate"
        return revoked.has(principal.credential) ? "terminate" : "deliver"
      },
      sessionId: (event) => event.sessionId,
    })
    const valid = source.open({ ...participant("connection_valid"), credential: "Bearer valid" })
    valid.subscribe(() => undefined)

    bus.publish({ sessionId: "ses_private", value: "valid-credential-only" })
    await source.flush()

    const denied = source.open({ ...participant("connection_revoked"), credential: "Bearer revoked" })
    await denied.ready

    expect(denied.replay.replayAfter("0")).toEqual([])
    expect(await denied.decide({ sessionId: "ses_private", value: "valid-credential-only" })).toBe("terminate")
    source.close()
  })

  test("evicts disconnected scopes and reconstructs replay from bounded retention", async () => {
    const bus = createBus<Event>()
    const decisions: string[] = []
    const source = createIdentityAwareEventSource<Event>({
      subscribe: (fn) => bus.subscribe(fn),
      sequenceOrigin: () => 0,
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
