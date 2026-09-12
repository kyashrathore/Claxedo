import { describe, expect, test } from "bun:test"
import { createAgentRuntime } from "../runtime"
import type { AgentHarnessFactory } from "../runtime"
import type { AgentHarnessAdapter } from "../adapter-contract"
import { createMemoryRuntimeStore } from "../stores/memory"
import { sessionIdle } from "../compat-events"
import type { AgentRuntimeStreamEvent, PromptInput } from "../index"

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

function harness(options: {
  turns: string[]
  steered?: PromptInput[]
  steerable?: boolean
  open?: () => TurnControl
  aborts?: string[]
}): AgentHarnessFactory {
  const adapter: AgentHarnessAdapter = {
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
    async abort(binding) {
      options.aborts?.push(binding.sessionId)
      return { ok: true as const, status: "cancelled" as const }
    },
    dispose() {},
  }
  return { id: "pi", access: "native", create: () => adapter } as unknown as AgentHarnessFactory
}

function promptText(input: PromptInput) {
  return input.parts.map((part) => ("text" in part ? part.text : "")).join("")
}

async function session(factory: AgentHarnessFactory) {
  const runtime = createAgentRuntime({ store: createMemoryRuntimeStore(), harnesses: [factory] })
  const created = await runtime.sessions.create({
    id: "ses_busy",
    workspaceId: "ws",
    directory: "/repo",
    harness: { id: "pi", access: "native" },
  })
  return { runtime, sessionId: created.id }
}

describe("prompts for a session that is already running a turn", () => {
  test("a steer delivery reaches the running turn's driver and shows up as a user message", async () => {
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
    expect(steered.map(promptText)).toEqual(["also update the readme"])
    expect(turns).toEqual(["start the work"])
    // The steered prompt joined the running turn rather than opening one.
    expect(second.assistantMessageId).toBe(first.assistantMessageId)
    const messages = await runtime.events.list(sessionId, "/repo")
    expect(messages.filter((message) => message.info.role === "user").map((message) => message.info.id))
      .toEqual(["msg_first", "msg_steer"])
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

describe("scoping an abort to the turn the caller was looking at", () => {
  test("an abort naming the running turn cancels it", async () => {
    const aborts: string[] = []
    const control = openTurn("ses_busy")
    const { runtime, sessionId } = await session(harness({ turns: [], aborts, open: () => control }))
    await runtime.turns.start({ sessionId, messageId: "msg_first", text: "start the work" })

    const result = await runtime.turns.abort(sessionId, "/repo", { turnId: "msg_first" })

    expect(result).toEqual({ ok: true, status: "cancelled" })
    expect(aborts).toEqual([sessionId])
    control.finish()
    await runtime.dispose()
  })

  test("an abort naming a turn that already ended leaves the running one alone", async () => {
    const aborts: string[] = []
    const control = openTurn("ses_busy")
    const { runtime, sessionId } = await session(harness({ turns: [], aborts, open: () => control }))
    await runtime.turns.start({ sessionId, messageId: "msg_second", text: "start the work" })

    const result = await runtime.turns.abort(sessionId, "/repo", { turnId: "msg_first" })

    expect(result).toEqual({ ok: true, status: "already_idle" })
    expect(aborts).toEqual([])
    control.finish()
    await runtime.dispose()
  })

  test("an abort with no turn id still stops whatever is running", async () => {
    const aborts: string[] = []
    const control = openTurn("ses_busy")
    const { runtime, sessionId } = await session(harness({ turns: [], aborts, open: () => control }))
    await runtime.turns.start({ sessionId, messageId: "msg_first", text: "start the work" })

    expect(await runtime.turns.abort(sessionId, "/repo")).toEqual({ ok: true, status: "cancelled" })
    expect(aborts).toEqual([sessionId])
    control.finish()
    await runtime.dispose()
  })
})
