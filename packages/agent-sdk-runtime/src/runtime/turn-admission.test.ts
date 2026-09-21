import { describe, expect, test } from "bun:test"
import { createAgentRuntime } from "../runtime"
import { createTurnAdmissions } from "./turn-admission"
import type { AgentHarnessFactory } from "../runtime"
import type { AgentHarnessAdapter } from "../adapter-contract"
import { createMemoryRuntimeStore } from "../stores/memory"
import { sessionIdle } from "../compat-events"
import type { AgentRuntimeStreamEvent, PromptInput } from "../index"
import { createRuntimeEventHub } from "../runtime-event-hub"
import { RECOVERY_TEST_CALLER, cancelRuntimeTurn, cancelTurnRequest, submittedOperation } from "../test-utils/cancel-turn"
import type { AgentExecutionBinding } from "@claxedo/agent-runtime-contract"

type TurnControl = {
  finish: () => void
  events: AsyncIterable<AgentRuntimeStreamEvent>
}

function openTurn(sessionId: string): TurnControl {
  let release!: () => void
  const closed = new Promise<void>((resolve) => { release = resolve })
  return {
    finish: release,
    events: {
      async *[Symbol.asyncIterator]() {
        await closed
        yield sessionIdle(sessionId)
      },
    },
  }
}

function open(controls: TurnControl[]) {
  const control = openTurn("ses_busy")
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

async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 400 && !condition(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  if (!condition()) throw new Error("condition never held")
}

function harness(options: {
  turns: string[]
  steered?: PromptInput[]
  steerable?: boolean
  open?: () => TurnControl
  aborts?: string[]
}): AgentHarnessFactory {
  const adapter: AgentHarnessAdapter = {
    instructionChannel: "none",
    async getSession() { return null },
    async createSession(_directory, _title, id) { return { id: id ?? "ses_test" } },
    async updateSession() { return null },
    async getSessionConfig() { return { harness: { id: "pi", access: "native" }, variant: null, agent: "build" } },
    async updateSessionConfig(_binding, update) {
      return { harness: update.harness ?? { id: "pi", access: "native" }, variant: null, agent: null }
    },
    async deleteSession() {},
    readHarnessCapabilities: () => ({}) as never,
    executeTurn(_binding, input) {
      options.turns.push(promptText(input))
      return (options.open ?? (() => openTurn(_binding.sessionId)))().events
    },
    async getMessages() { return [] },
    ...(options.steerable
      ? {
          async steerTurn(_binding, input) {
            options.steered?.push(input)
            return { ok: true as const }
          },
        }
      : {}),
    async cancelTurn(binding: AgentExecutionBinding) {
      options.aborts?.push(binding.sessionId)
      return { execution: "terminal" as const, cleanup: "unknown" as const }
    },
    dispose() {},
  }
  return { id: "pi", access: "native", create: () => adapter } as unknown as AgentHarnessFactory
}

function promptText(input: PromptInput) {
  return input.parts.map((part) => ("text" in part ? part.text : "")).join("")
}

async function session(factory: AgentHarnessFactory) {
  const eventHub = createRuntimeEventHub()
  const runtime = createAgentRuntime({ store: createMemoryRuntimeStore(), harnesses: [factory], eventHub })
  const created = await runtime.sessions.create({
    id: "ses_busy",
    workspaceId: "ws",
    directory: "/repo",
    harness: { id: "pi", access: "native" },
  })
  return { runtime, sessionId: created.id, eventHub }
}

test("committed turn events publish once without an HTTP request subscription", async () => {
  const control = openTurn("ses_busy")
  const { runtime, sessionId, eventHub } = await session(harness({ turns: [], open: () => control }))
  const published: string[] = []
  const unsubscribe = eventHub.subscribeGlobal(({ payload }) => {
    if (payload.type === "message.updated") published.push(payload.properties.info.id)
    if (payload.type === "session.idle") published.push("idle")
  })
  const turn = await runtime.turns.start({ sessionId, messageId: "msg_first", text: "work" })
  expect(published).toEqual(["msg_first", turn.assistantMessageId])
  control.finish()
  await runtime.dispose()
  expect(published.filter((id) => id === "idle")).toHaveLength(1)
  unsubscribe()
})

test("steering after the target ended does not silently start a new turn", async () => {
  const turns: string[] = []
  const { runtime, sessionId } = await session(harness({ turns }))
  const result = await runtime.turns.start({ sessionId, messageId: "late", text: "late input", delivery: "steer" })
  expect(result.steering).toMatchObject({ ok: false, status: "no_active_turn" })
  expect(turns).toEqual([])
  expect(await runtime.events.list(sessionId, "/repo")).toEqual([])
  await runtime.dispose()
})

test("a steer suspended in adapter resolution cannot attach to a replacement turn", async () => {
  const store = createMemoryRuntimeStore()
  const eventHub = createRuntimeEventHub()
  const turns: string[] = []
  const steered: PromptInput[] = []
  const controls: TurnControl[] = []
  const factory = harness({ turns, steered, steerable: true, open: () => open(controls) })
  const adapter = factory.create({ store, eventHub, reportOwnerFailure: () => {} })
  let resolved!: (adapter: AgentHarnessAdapter) => void
  let resolving!: () => void
  const entered = new Promise<void>((resolve) => { resolving = resolve })
  const runtime = createAgentRuntime({
    store, eventHub, harnesses: [factory],
    resolveHarness: () => { resolving(); return new Promise((resolve) => { resolved = resolve }) },
  })
  const sessionId = "ses_busy"
  await runtime.sessions.create({ id: sessionId, workspaceId: "ws", directory: "/repo", harness: { id: "pi", access: "native" } })
  await runtime.turns.start({ sessionId, messageId: "first", text: "first" })
  store.updateSessionConfig(sessionId, { harness: { id: "claude", access: "native" } })
  const steering = runtime.turns.start({ sessionId, messageId: "steer", text: "S", delivery: "steer" })
  await entered
  controls[0].finish()
  const idle = await runtime.turns.whenIdle(sessionId)
  store.updateSessionConfig(sessionId, { harness: { id: "pi", access: "native" } })
  await runtime.turns.start({ sessionId, messageId: "replacement", text: "replacement" })
  idle.abandon()
  resolved(adapter)
  expect((await steering).steering).toMatchObject({ ok: false, status: "no_active_turn" })
  expect(steered).toEqual([])
  expect(turns).toEqual(["first", "replacement"])
  controls[1].finish()
  await runtime.dispose()
})

test("a failed host admission hook releases the runtime turn claim", async () => {
  const control = openTurn("ses_busy")
  const { runtime, sessionId } = await session(harness({ turns: [], open: () => control }))
  await expect(runtime.turns.start({ sessionId, text: "rejected", onAdmitted() { throw new Error("workspace frozen") } })).rejects.toThrow("workspace frozen")
  const admitted = await runtime.turns.start({ sessionId, text: "next" })
  expect(admitted.delivery).toBe("start")
  control.finish()
  await runtime.dispose()
})

describe("prompts for a session that is already running a turn", () => {
  test("provider acceptance does not invent transcript incorporation", async () => {
    const turns: string[] = []
    const steered: PromptInput[] = []
    const control = openTurn("ses_busy")
    const { runtime, sessionId } = await session(harness({ turns, steered, steerable: true, open: () => control }))
    const first = await runtime.turns.start({ sessionId, messageId: "msg_first", text: "start the work" })

    const second = await runtime.turns.start({
      sessionId,
      messageId: "msg_steer",
      text: "also update the readme",
      delivery: "steer",
    })

    expect(second.delivery).toBe("steer")
    expect(second.steering).toEqual({ ok: true })
    expect(steered.map(promptText)).toEqual(["also update the readme"])
    expect(turns).toEqual(["start the work"])
    // The steered prompt joined the running turn rather than opening one.
    expect(second.assistantMessageId).toBe(first.assistantMessageId)
    const messages = await runtime.events.list(sessionId, "/repo")
    expect(messages.filter((message) => message.info.role === "user").map((message) => message.info.id))
      .toEqual(["msg_first"])
    expect(messages.filter((message) => message.info.role === "assistant").map((message) => message.info.id))
      .toEqual([first.assistantMessageId])

    control.finish()
    await runtime.dispose()
  })

  test("a queue delivery waits for the running turn and then runs as its own", async () => {
    const turns: string[] = []
    const control = openTurn("ses_busy")
    const { runtime, sessionId } = await session(harness({ turns, open: () => control }))
    await runtime.turns.start({ sessionId, messageId: "msg_first", text: "start the work" })
    const queuedTurn = { sessionId, messageId: "msg_queued", text: "then run the tests" } as const

    const queued = await runtime.turns.start({ ...queuedTurn, delivery: "queue" })

    expect(queued.delivery).toBe("queue")
    expect(turns).toEqual(["start the work"])
    const held = runtime.turns.whenIdle(sessionId).then(() => runtime.turns.start(queuedTurn))
    control.finish()
    expect((await held).delivery).toBe("start")
    expect(turns).toEqual(["start the work", "then run the tests"])
    await runtime.dispose()
  })

  test("prompts queued for one session start in the order they were queued", async () => {
    const turns: string[] = []
    const controls: TurnControl[] = []
    const { runtime, sessionId } = await session(harness({ turns, open: () => open(controls) }))
    await runtime.turns.start({ sessionId, messageId: "msg_first", text: "start the work" })

    const queued = ["a", "b", "c"].map((text) => runtime.turns.whenIdle(sessionId)
      .then(() => runtime.turns.start({ sessionId, messageId: `msg_${text}`, text })))

    await finishInOrder(controls, 4)
    await Promise.all(queued)
    expect(turns).toEqual(["start the work", "a", "b", "c"])
    await runtime.dispose()
  })

  test("a prompt queued while an earlier queued one runs still starts behind it", async () => {
    const turns: string[] = []
    const controls: TurnControl[] = []
    const { runtime, sessionId } = await session(harness({ turns, open: () => open(controls) }))
    await runtime.turns.start({ sessionId, messageId: "msg_first", text: "start the work" })
    const queued = ["a", "b"].map((text) => runtime.turns.whenIdle(sessionId)
      .then(() => runtime.turns.start({ sessionId, messageId: `msg_${text}`, text })))

    controls[0].finish()
    await until(() => turns.includes("a"))
    const late = runtime.turns.whenIdle(sessionId)
      .then(() => runtime.turns.start({ sessionId, messageId: "msg_late", text: "late" }))

    await finishInOrder(controls, 4)
    await Promise.all([...queued, late])
    expect(turns).toEqual(["start the work", "a", "b", "late"])
    await runtime.dispose()
  })

  test("a steer the harness cannot take is queued, not refused", async () => {
    const turns: string[] = []
    const control = openTurn("ses_busy")
    const { runtime, sessionId } = await session(harness({ turns, steerable: false, open: () => control }))
    await runtime.turns.start({ sessionId, messageId: "msg_first", text: "start the work" })

    const second = await runtime.turns.start({
      sessionId,
      messageId: "msg_steer",
      text: "and also this",
      delivery: "steer",
    })

    expect(second.delivery).toBe("queue")
    expect(second.steering).toMatchObject({ ok: false, status: "unsupported" })
    expect(turns).toEqual(["start the work"])
    control.finish()
    await runtime.dispose()
  })

  test("a session with nothing running is idle at once, so a queued prompt starts immediately", async () => {
    const control = openTurn("ses_busy")
    const { runtime, sessionId } = await session(harness({ turns: [], open: () => control }))
    await runtime.turns.start({ sessionId, messageId: "msg_first", text: "start the work" })
    control.finish()

    await runtime.turns.whenIdle(sessionId)
    await runtime.dispose()
  })

  test("a prompt with no delivery still takes the admission conflict", async () => {
    const control = openTurn("ses_busy")
    const { runtime, sessionId } = await session(harness({ turns: [], open: () => control }))
    await runtime.turns.start({ sessionId, messageId: "msg_first", text: "start the work" })

    await expect(runtime.turns.start({ sessionId, messageId: "msg_second", text: "second" }))
      .rejects.toThrow("already processing")

    control.finish()
    await runtime.dispose()
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
  test("a cancellation naming the running turn stops it", async () => {
    const aborts: string[] = []
    const control = openTurn("ses_busy")
    const { runtime, sessionId } = await session(harness({ turns: [], aborts, open: () => control }))
    const started = await runtime.turns.start({ sessionId, messageId: "msg_first", text: "start the work" })

    const operation = submittedOperation(await runtime.recovery.submit(
      cancelTurnRequest(started.target!),
      RECOVERY_TEST_CALLER,
    ))

    expect(operation.facts.execution.value).toBe("terminal")
    expect(operation.facts.persistence.value).toBe("committed")
    expect(aborts).toEqual([sessionId])
    control.finish()
    await runtime.dispose()
  })

  test("a cancellation naming a turn that already ended leaves the running one alone", async () => {
    const aborts: string[] = []
    const control = openTurn("ses_busy")
    const { runtime, sessionId } = await session(harness({ turns: [], aborts, open: () => control }))
    const started = await runtime.turns.start({ sessionId, messageId: "msg_second", text: "start the work" })

    const outcome = await runtime.recovery.submit(
      cancelTurnRequest({ ...started.target!, turnId: "msg_first", ownerGeneration: "an-older-lease" }),
      RECOVERY_TEST_CALLER,
    )

    expect(outcome).toMatchObject({ kind: "refused", refusal: { kind: "generation_conflict" } })
    expect(aborts).toEqual([])
    expect(runtime.recovery.inspect(sessionId).target).toMatchObject({ turnId: "msg_second" })
    control.finish()
    await runtime.dispose()
  })

  test("a cancellation of the turn a caller just read stops it", async () => {
    const aborts: string[] = []
    const control = openTurn("ses_busy")
    const { runtime, sessionId } = await session(harness({ turns: [], aborts, open: () => control }))
    await runtime.turns.start({ sessionId, messageId: "msg_first", text: "start the work" })

    expect(submittedOperation(await cancelRuntimeTurn(runtime, sessionId)).facts.execution.value).toBe("terminal")
    expect(aborts).toEqual([sessionId])
    control.finish()
    await runtime.dispose()
  })
})
