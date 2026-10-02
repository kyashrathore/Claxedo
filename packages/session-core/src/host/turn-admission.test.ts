import { describe, expect, test } from "bun:test"
import type { SessionBroker, TurnInput } from "@claxedo/harness/contract"
import {
  RECOVERY_TEST_CALLER,
  cancelRuntimeTurn,
  cancelTurnRequest,
  controlledTurn,
  createHostFixture,
  promptText,
  sessionCreate,
  submittedOperation,
  until,
  type TurnControl,
  tempStoreRoot,
  LOOPBACK_ORIGIN,
  tick,
} from "../test-support/host-fixture"
import { FakeTransport } from "../test-support/fake-transport"
import { createTurnAdmissions } from "./turn-admission"
import { rmSync } from "node:fs"
import { openTestRuntimeStore } from "../test-support/store"

function open(controls: TurnControl[]) {
  const control = controlledTurn("ses_busy")
  controls.push(control)
  return control
}

/** Finish each turn as the session hands it on, so the next waiter can start. */
async function finishInOrder(controls: TurnControl[], count: number) {
  for (let index = 0; index < count; index++) {
    await until(() => controls.length > index)
    controls[index].finish()
  }
}

function harness(options: {
  turns: string[]
  steered?: TurnInput[]
  steerable?: boolean
  open?: () => TurnControl
  beforeCapabilities?: () => Promise<void>
}) {
  return new FakeTransport({
    kind: "pi-rpc",
    turn: (input) => {
      options.turns.push(promptText(input))
      return (options.open ?? (() => controlledTurn(input.session.binding.sessionId)))().events
    },
    ...(options.steerable
      ? {
          steer: async (_session, _turn, input) => {
            options.steered?.push(input)
            return { ok: true as const }
          },
        }
      : {}),
    ...(options.beforeCapabilities ? { beforeCapabilities: options.beforeCapabilities } : {}),
  })
}

async function session(transport: FakeTransport) {
  const fixture = createHostFixture({ transports: { pi: transport } })
  const created = await fixture.runtime.sessions.create(sessionCreate({ id: "ses_busy" }))
  return { ...fixture, sessionId: created.id }
}

test("committed turn events publish once without an HTTP request subscription", async () => {
  const control = controlledTurn("ses_busy")
  const { runtime, sessionId, eventHub, dispose } = await session(harness({ turns: [], open: () => control }))
  const published: string[] = []
  const unsubscribe = eventHub.subscribeGlobal(({ payload }) => {
    if (payload.type === "message.updated") published.push(payload.properties.info.id)
    if (payload.type === "session.idle") published.push("idle")
  })
  const turn = await runtime.turns.start({ sessionId, messageId: "msg_first", text: "work", origin: sessionCreate().origin })
  expect(published).toEqual(["msg_first", turn.assistantMessageId])
  control.finish()
  await runtime.dispose()
  expect(published.filter((id) => id === "idle")).toHaveLength(1)
  unsubscribe()
  await dispose()
})

test("steering after the target ended does not silently start a new turn", async () => {
  const turns: string[] = []
  const { runtime, sessionId, dispose } = await session(harness({ turns }))
  const result = await runtime.turns.start({ sessionId, messageId: "late", text: "late input", delivery: "steer", origin: sessionCreate().origin })
  expect(result.steering).toMatchObject({ ok: false, status: "no_active_turn" })
  expect(turns).toEqual([])
  expect(await runtime.events.list(sessionId, "/repo")).toEqual([])
  await dispose()
})

test("a steer suspended in harness resolution cannot attach to a replacement turn", async () => {
  const turns: string[] = []
  const steered: TurnInput[] = []
  const controls: TurnControl[] = []
  let armed = false
  let resume!: () => void
  let entered!: () => void
  const suspended = new Promise<void>((resolve) => { entered = resolve })
  const transport = harness({
    turns, steered, steerable: true, open: () => open(controls),
    beforeCapabilities: () => {
      if (!armed) return Promise.resolve()
      armed = false
      entered()
      return new Promise<void>((resolve) => { resume = resolve })
    },
  })
  const { runtime, sessionId, dispose } = await session(transport)
  const origin = sessionCreate().origin
  await runtime.turns.start({ sessionId, messageId: "first", text: "first", origin })
  armed = true
  const steering = runtime.turns.start({ sessionId, messageId: "steer", text: "S", delivery: "steer", origin })
  await suspended
  controls[0].finish()
  const idle = await runtime.turns.whenIdle(sessionId)
  await runtime.turns.start({ sessionId, messageId: "replacement", text: "replacement", origin })
  idle.abandon()
  resume()
  expect((await steering).steering).toMatchObject({ ok: false, status: "no_active_turn" })
  expect(steered).toEqual([])
  expect(turns).toEqual(["first", "replacement"])
  controls[1].finish()
  await dispose()
})

test("a steer and a stop reach the running turn under the binding it rebound to", async () => {
  const control = controlledTurn("ses_busy")
  let sessions!: SessionBroker
  const addressed: string[] = []
  const transport = new FakeTransport({
    beforeStart: async (_input, broker) => { sessions = broker },
    turn: () => (async function* () {
      await sessions.rebind("upstream-reported-by-first-message")
      yield* control.events
    })(),
    steer: async (session) => {
      addressed.push(`steer ${session.binding.upstreamSessionId}`)
      return { ok: true as const }
    },
    cancel: async ({ session }) => {
      addressed.push(`cancel ${session.binding.upstreamSessionId}`)
      control.finish()
      return { execution: "terminal", cleanup: "verified_clear" }
    },
  })
  const { runtime, sessionId, store, dispose } = await session(transport)
  const origin = sessionCreate().origin
  await runtime.turns.start({ sessionId, messageId: "first", text: "first", origin })
  await until(() => store.getExecutionBinding(sessionId)?.upstreamSessionId === "upstream-reported-by-first-message", "rebind")
  expect((await runtime.turns.start({ sessionId, messageId: "steer", text: "S", delivery: "steer", origin })).steering).toEqual({ ok: true })
  submittedOperation(await cancelRuntimeTurn(runtime, sessionId))
  expect(addressed).toEqual(["steer upstream-reported-by-first-message", "cancel upstream-reported-by-first-message"])
  await dispose()
})

test("a steer the harness never answers is unknown once its turn ends", async () => {
  const control = controlledTurn("ses_busy")
  let reached!: () => void
  const steering = new Promise<void>((resolve) => { reached = resolve })
  const transport = new FakeTransport({
    turn: () => control.events,
    steer: () => {
      reached()
      return new Promise(() => {})
    },
  })
  const { runtime, sessionId, dispose } = await session(transport)
  const origin = sessionCreate().origin
  await runtime.turns.start({ sessionId, messageId: "first", text: "first", origin })
  const steered = runtime.turns.start({ sessionId, messageId: "steer", text: "S", delivery: "steer", origin })
  await steering
  control.finish()
  expect((await steered).steering).toEqual({ ok: false, status: "unknown", message: "The turn ended before the harness answered the steer" })
  await dispose()
})

test("a failed host admission hook releases the runtime turn claim", async () => {
  const control = controlledTurn("ses_busy")
  const { runtime, sessionId, dispose } = await session(harness({ turns: [], open: () => control }))
  const origin = sessionCreate().origin
  await expect(runtime.turns.start({ sessionId, text: "rejected", origin, onAdmitted() { throw new Error("workspace frozen") } })).rejects.toThrow("workspace frozen")
  const admitted = await runtime.turns.start({ sessionId, text: "next", origin })
  expect(admitted.delivery).toBe("start")
  control.finish()
  await dispose()
})

describe("prompts for a session that is already running a turn", () => {
  test("prompts queued for one session start in the order they were queued", async () => {
    const turns: string[] = []
    const controls: TurnControl[] = []
    const { runtime, sessionId, dispose } = await session(harness({ turns, open: () => open(controls) }))
    const origin = sessionCreate().origin
    await runtime.turns.start({ sessionId, messageId: "msg_first", text: "start the work", origin })

    const queued = ["a", "b", "c"].map((text) => runtime.turns.whenIdle(sessionId)
      .then(() => runtime.turns.start({ sessionId, messageId: `msg_${text}`, text, origin })))

    await finishInOrder(controls, 4)
    await Promise.all(queued)
    expect(turns).toEqual(["start the work", "a", "b", "c"])
    await dispose()
  })

  test("a prompt queued while an earlier queued one runs still starts behind it", async () => {
    const turns: string[] = []
    const controls: TurnControl[] = []
    const { runtime, sessionId, dispose } = await session(harness({ turns, open: () => open(controls) }))
    const origin = sessionCreate().origin
    await runtime.turns.start({ sessionId, messageId: "msg_first", text: "start the work", origin })
    const queued = ["a", "b"].map((text) => runtime.turns.whenIdle(sessionId)
      .then(() => runtime.turns.start({ sessionId, messageId: `msg_${text}`, text, origin })))

    controls[0].finish()
    await until(() => turns.includes("a"))
    const late = runtime.turns.whenIdle(sessionId)
      .then(() => runtime.turns.start({ sessionId, messageId: "msg_late", text: "late", origin }))

    await finishInOrder(controls, 4)
    await Promise.all([...queued, late])
    expect(turns).toEqual(["start the work", "a", "b", "late"])
    await dispose()
  })

  test("a session with nothing running is idle at once, so a queued prompt starts immediately", async () => {
    const control = controlledTurn("ses_busy")
    const { runtime, sessionId, dispose } = await session(harness({ turns: [], open: () => control }))
    await runtime.turns.start({ sessionId, messageId: "msg_first", text: "start the work", origin: sessionCreate().origin })
    control.finish()

    await runtime.turns.whenIdle(sessionId)
    await dispose()
  })

  test("a prompt with no delivery still takes the admission conflict", async () => {
    const control = controlledTurn("ses_busy")
    const { runtime, sessionId, dispose } = await session(harness({ turns: [], open: () => control }))
    const origin = sessionCreate().origin
    await runtime.turns.start({ sessionId, messageId: "msg_first", text: "start the work", origin })

    await expect(runtime.turns.start({ sessionId, messageId: "msg_second", text: "second", origin }))
      .rejects.toThrow("already processing")

    control.finish()
    await dispose()
  })
})

describe("handing an idle session to the prompts waiting for it", () => {
  function running(woken: string[]) {
    const turns = createTurnAdmissions({ acquireTurnLease: () => "lease", releaseTurnLease: () => {} })
    const claimed = turns.claim("ses", { turnId: "msg_first", assistantMessageId: "asst_first" })!
    const handoffs = new Map<string, { abandon: () => void }>()
    const wait = (name: string) => void turns.whenIdle("ses").then((handoff) => {
      handoffs.set(name, handoff)
      woken.push(name)
    })
    wait("a")
    wait("b")
    return { turns, claimed, wait, handoffs }
  }

  async function settle() {
    for (let tick = 0; tick < 5; tick++) await new Promise((resolve) => setTimeout(resolve, 0))
  }

  test("a prompt that starts waiting after the turn ended still waits behind the queue", async () => {
    const woken: string[] = []
    const session = running(woken)

    session.claimed.release()
    session.wait("late")
    await settle()

    expect(woken).toEqual(["a"])
  })

  test("a woken prompt that cannot start hands the session to the next waiter", async () => {
    const woken: string[] = []
    const session = running(woken)

    session.claimed.release()
    await settle()
    session.handoffs.get("a")!.abandon()
    await settle()

    expect(woken).toEqual(["a", "b"])
  })

  test("giving the session up after it was claimed hands nothing on", async () => {
    const woken: string[] = []
    const session = running(woken)

    session.claimed.release()
    await settle()
    const next = session.turns.claim("ses", { turnId: "msg_a", assistantMessageId: "asst_a" })!
    session.handoffs.get("a")!.abandon()
    await settle()
    expect(woken).toEqual(["a"])

    next.release()
    await settle()
    expect(woken).toEqual(["a", "b"])
  })

  test("a session handed to a waiter is still busy to a prompt that arrives before it claims", async () => {
    const woken: string[] = []
    const session = running(woken)

    session.claimed.release()
    await settle()
    session.wait("late")
    await settle()
    expect(woken).toEqual(["a"])

    session.handoffs.get("a")!.abandon()
    await settle()
    session.handoffs.get("b")!.abandon()
    await settle()
    expect(woken).toEqual(["a", "b", "late"])
  })

  test("a session whose last waiter has run is idle again to the next prompt", async () => {
    const woken: string[] = []
    const session = running(woken)

    session.claimed.release()
    await settle()
    session.turns.claim("ses", { turnId: "msg_a", assistantMessageId: "asst_a" })!.release()
    await settle()
    session.turns.claim("ses", { turnId: "msg_b", assistantMessageId: "asst_b" })!.release()
    await settle()
    expect(woken).toEqual(["a", "b"])

    session.wait("late")
    await settle()
    expect(woken).toEqual(["a", "b", "late"])
  })

  test("a release from a generation that no longer owns the session wakes nobody", async () => {
    const woken: string[] = []
    const session = running(woken)
    const stale = session.claimed.generation

    session.claimed.release()
    await settle()
    const next = session.turns.claim("ses", { turnId: "msg_a", assistantMessageId: "asst_a" })!
    session.turns.release("ses", stale)
    session.turns.release("ses", stale)
    await settle()

    expect(woken).toEqual(["a"])
    expect(session.turns.active("ses")?.generation).toBe(next.generation)
  })

  test("disposal releases every prompt still waiting", async () => {
    const woken: string[] = []
    const session = running(woken)

    session.turns.clear()
    await settle()

    expect(woken).toEqual(["a", "b"])
  })
})

describe("scoping a cancellation to the turn the caller was looking at", () => {
  test("a cancellation naming a turn that already ended leaves the running one alone", async () => {
    const control = controlledTurn("ses_busy")
    const transport = harness({ turns: [], open: () => control })
    const { runtime, sessionId, dispose } = await session(transport)
    const started = await runtime.turns.start({ sessionId, messageId: "msg_second", text: "start the work", origin: sessionCreate().origin })

    const outcome = await runtime.recovery.submit(
      cancelTurnRequest({ ...started.target!, turnId: "msg_first", ownerGeneration: "an-older-lease" }),
      RECOVERY_TEST_CALLER,
    )

    expect(outcome).toMatchObject({ kind: "refused", refusal: { kind: "generation_conflict" } })
    expect(transport.cancels).toHaveLength(0)
    expect(runtime.recovery.inspect(sessionId).target).toMatchObject({ turnId: "msg_second" })
    control.finish()
    await dispose()
  })
})

describe("durable turn authority", () => {
  const record = { sessionId: "s", userMessageId: "u", assistantMessageId: "a", agent: "build", parts: [{ type: "text" as const, text: "work" }] }

  test("the same active assistant turn starts once with the same durable receipt", async () => {
    const f = createHostFixture({ transports: { pi: new FakeTransport() } })
    try {
      await f.runtime.sessions.create(sessionCreate({ id: "s" }))
      const first = f.store.startTurn(record)
      const replay = f.store.startTurn(record)
      expect(replay).toMatchObject({ sessionId: first.sessionId, seq: first.seq, createdAt: first.createdAt, events: [] })
      expect(f.store.getMessages("s")).toHaveLength(2)
    } finally { await f.dispose() }
  })

  test("a competing domain receives no lease and double release cannot strand a session", async () => {
    const f = createHostFixture({ transports: { pi: new FakeTransport() } })
    try {
      await f.runtime.sessions.create(sessionCreate({ id: "s" }))
      const owner = createTurnAdmissions(f.store)
      const competing = createTurnAdmissions(f.store)
      const first = owner.claim("s", { turnId: "u", assistantMessageId: "a" })!
      expect(competing.claim("s", { turnId: "other", assistantMessageId: "other" })).toBeUndefined()
      expect(f.store.readTurnAuthority("s")?.leaseId).toBe(first.leaseId)
      first.release()
      first.release()
      const next = competing.claim("s", { turnId: "next", assistantMessageId: "next" })!
      expect(next).toBeDefined()
      first.release()
      expect(f.store.readTurnAuthority("s")?.leaseId).toBe(next.leaseId)
      next.release()
    } finally { await f.dispose() }
  })

  test("a persisted unfinished turn is unknown to a replacement host and refuses stale cancellation", async () => {
    const root = tempStoreRoot()
    let store = openTestRuntimeStore(root)
    const transport = new FakeTransport()
    let f = createHostFixture({ store, transports: { pi: transport } })
    try {
      await f.runtime.sessions.create(sessionCreate({ id: "s" }))
      store.startTurn(record)
      await f.runtime.dispose()
      store.close()
      store = openTestRuntimeStore(root)
      f = createHostFixture({ store, transports: { pi: transport } })
      const inspection = f.runtime.recovery.inspect("s")
      expect(inspection.target).toBeUndefined()
      expect(inspection.facts).toMatchObject({ execution: { value: "unknown" }, persistence: { value: "pending" } })
      expect(await f.runtime.recovery.submit(cancelTurnRequest({ scope: "turn", workspaceId: "ws", sessionId: "s", turnId: "u", ownerGeneration: "previous" }), RECOVERY_TEST_CALLER))
        .toMatchObject({ kind: "refused", refusal: { kind: "generation_conflict" } })
      expect(transport.cancels).toEqual([])
      expect(store.getSession("s")?.status).toBe("busy")
      await f.runtime.turns.start({ sessionId: "s", text: "continue", origin: LOOPBACK_ORIGIN })
      await f.runtime.dispose()
      expect(store.getSession("s")?.lastTurn?.status).toBe("completed")
    } finally { await f.runtime.dispose(); store.close(); rmSync(root, { recursive: true, force: true }) }
  })

  test("a durable fence takeover rejects stale producer completion without ending its replacement", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const transport = new FakeTransport({ turn: async function* () { await gate; yield { type: "finish", sessionId: "s" } } })
    const f = createHostFixture({ transports: { pi: transport } })
    let valid = true
    try {
      await f.runtime.sessions.create(sessionCreate({ id: "s" }))
      await f.runtime.turns.start({ sessionId: "s", text: "work", origin: LOOPBACK_ORIGIN, admission: { valid: () => valid, fencingToken: () => 1, proof: () => "turn-lease" } })
      f.store.startTurn({ ...record, assistantMessageId: "replacement", fencingToken: 2 })
      valid = false
      release()
      await tick()
      await f.runtime.dispose()
      expect(f.store.getSession("s")?.status).toBe("busy")
      expect(f.store.getSession("s")?.lastTurn).toBeUndefined()
      expect(f.store.getMessages("s").map((row) => row.info.id)).toContain("replacement")
    } finally { release(); await f.dispose() }
  })
})
