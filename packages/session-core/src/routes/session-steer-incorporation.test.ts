import { testSessionRoutePorts } from "../test-support/session-core"
import { afterEach, expect, test } from "bun:test"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { SessionRoutes } from "./session"
import { FakeTransport } from "../test-support/fake-transport"
import { cancelRuntimeTurn, createHostFixture, sessionCreate, until } from "../test-support/host-fixture"
import { queuedPromptStore } from "./session-store-reads"

const cleanups: Array<() => Promise<unknown>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/**
 * A running turn that writes `before`, takes the steered prompt in once the
 * steer reaches the harness, writes `after`, and then ends with `ending`, or
 * with no terminal once it is stopped.
 */
function steeredTurn(ending: AgentRuntimeEvent | "stopped", afterSteer: AgentRuntimeEvent[] = []) {
  let steered!: (messageId: string) => void
  const steer = new Promise<string>((resolve) => { steered = resolve })
  const transport = new FakeTransport({
    async *turn({ broker }) {
      yield { type: "text-delta", delta: "before" }
      yield { type: "input-incorporated", messageId: await steer }
      yield { type: "text-delta", delta: "after" }
      yield* afterSteer
      if (ending !== "stopped") yield ending
      else await new Promise((resolve) => broker.signal.addEventListener("abort", resolve, { once: true }))
    },
    steer: async (_session, _turn, input) => {
      steered(input.userMessageId)
      return { ok: true }
    },
  })
  const host = createHostFixture({ transports: { pi: transport } })
  const routes = SessionRoutes(async () => host.runtime, { ...testSessionRoutePorts(), eventHub: host.eventHub, queuedPrompts: () => queuedPromptStore(host.store),
    requestedSessionHarness: (requested) => requested ?? { id: "pi", access: "native" } })
  cleanups.push(() => host.dispose(), () => routes.dispose())
  const post = (path: string, body: unknown) => routes.routes.request(path, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  return { host, transport, post }
}

async function steerMidTurn(fixture: ReturnType<typeof steeredTurn>, afterSteer: () => Promise<void> = async () => {}) {
  await fixture.host.runtime.sessions.create(sessionCreate({ id: "session_1" }))
  let idle = false
  const unsubscribe = fixture.host.eventHub.subscribeGlobal(({ payload }) => {
    if (payload.type === "session.idle" || payload.type === "session.error") idle = true
  })
  cleanups.push(async () => unsubscribe())
  const opened = await fixture.post("/session/session_1/prompt_async", { messageID: "msg_a_open", parts: [{ type: "text", text: "work" }] })
  expect(opened.status).toBe(204)
  await until(() => fixture.transport.turns.length === 1, "the opening turn reached the harness")
  const steered = await fixture.post("/session/session_1/prompt_async",
    { messageID: "msg_b_steer", delivery: "steer", parts: [{ type: "text", text: "show me with html" }] })
  expect(steered.status).toBe(200)
  await afterSteer()
  await until(() => idle, "the turn ended")
  return fixture.host.runtime.events.list("session_1", "/repo")
}

function text(message: { parts: readonly unknown[] }) {
  return message.parts.flatMap((part) => {
    const row = part as { type?: string; text?: string }
    return row.type === "text" && row.text ? [row.text] : []
  }).join("")
}

test("a steered prompt lands in the transcript where the harness took it in, and leaves the queue", async () => {
  const fixture = steeredTurn({ type: "finish", sessionId: "session_1" })
  const messages = await steerMidTurn(fixture)

  expect(messages.map((message) => ({
    id: message.info.id,
    role: message.info.role,
    parent: message.info.role === "assistant" ? message.info.parentID : undefined,
    completed: message.info.role === "assistant" ? message.info.time?.completed !== undefined : undefined,
    text: text(message),
  }))).toEqual([
    { id: "msg_a_open", role: "user", parent: undefined, completed: undefined, text: "work" },
    { id: "msg_a_open_r", role: "assistant", parent: "msg_a_open", completed: true, text: "before" },
    { id: "msg_b_steer", role: "user", parent: undefined, completed: undefined, text: "show me with html" },
    { id: "msg_b_steer_r", role: "assistant", parent: "msg_b_steer", completed: true, text: "after" },
  ])
  expect(fixture.host.store.deliveryQueue.listQueuedPrompts()).toEqual([])
})

test("a turn that fails after a steer records its error on the reply it failed in", async () => {
  const fixture = steeredTurn({ type: "error", error: "provider went away" })
  const messages = await steerMidTurn(fixture)

  const replies = messages.filter((message) => message.info.role === "assistant").map((message) => message.info)
  expect(replies.map((reply) => [reply.id, reply.role === "assistant" && reply.error !== undefined])).toEqual([
    ["msg_a_open_r", false],
    ["msg_b_steer_r", true],
  ])
  expect(fixture.host.store.deliveryQueue.listQueuedPrompts()).toEqual([])
})

test("stopping a turn after a steer closes the reply it stopped in and frees the session", async () => {
  const fixture = steeredTurn("stopped")
  const messages = await steerMidTurn(fixture, async () => {
    await until(() => fixture.host.store.getMessages("session_1").some((message) => text(message) === "after"), "the steered reply streamed")
    await cancelRuntimeTurn(fixture.host.runtime, "session_1")
  })

  const replies = messages.filter((message) => message.info.role === "assistant").map((message) => message.info)
  expect(replies.map((reply) => [reply.id, reply.role === "assistant" && reply.time?.completed !== undefined])).toEqual([
    ["msg_a_open_r", true],
    ["msg_b_steer_r", true],
  ])
  expect(fixture.host.store.getSession("session_1")?.status).not.toBe("busy")
})

test("a steered turn's coverage holds the steered prompt and the reply it ended in, and stops at the next turn", async () => {
  const fixture = steeredTurn({ type: "finish", sessionId: "session_1" })
  await steerMidTurn(fixture)
  const steeredTurns = fixture.transport.turns.length
  const next = await fixture.post("/session/session_1/prompt_async", { messageID: "msg_c_next", parts: [{ type: "text", text: "next" }] })
  expect(next.status).toBe(204)
  await until(() => fixture.transport.turns.length === steeredTurns + 1, "the next turn reached the harness")

  for (const turnId of ["msg_a_open", "msg_a_open_r"]) {
    const coverage = fixture.host.store.turnCoverage("session_1", turnId)
    expect(coverage.coverage).toBe("complete")
    expect(coverage.messages.map((message) => message.info.id)).toEqual(["msg_a_open", "msg_a_open_r", "msg_b_steer", "msg_b_steer_r"])
  }
})

test("the latest-turn pages hold the whole steered turn, including a later step that answers its own prompt", async () => {
  const fixture = steeredTurn({ type: "finish", sessionId: "session_1" }, [
    { type: "step-start", newMessageId: "msg_a_step" },
    { type: "text-delta", delta: "stepped" },
  ])
  const messages = await steerMidTurn(fixture)
  expect(messages.find((message) => message.info.id === "msg_a_step")?.info).toMatchObject({ role: "assistant", parentID: "msg_a_open" })

  const latest = fixture.host.store.getMessagePage("session_1", { view: "latest-turn" })
  expect(latest?.messages.map((message) => message.info.id)).toEqual(["msg_a_open", "msg_a_open_r", "msg_b_steer", "msg_b_steer_r", "msg_a_step"])
  expect(latest?.nextCursor).toBeUndefined()
  const surface = fixture.host.store.getMessagePage("session_1", { view: "latest-surface" })
  expect(surface?.messages.map((message) => [message.info.id, text(message)])).toEqual([
    ["msg_a_open", "work"],
    ["msg_b_steer", "show me with html"],
    ["msg_a_step", "stepped"],
  ])
})

test("a steered prompt and every reply after it carry the turn they were taken into, and a rebuild assigns the same turns", async () => {
  const fixture = steeredTurn({ type: "finish", sessionId: "session_1" }, [
    { type: "step-start", newMessageId: "msg_a_step" },
    { type: "text-delta", delta: "stepped" },
  ])
  await steerMidTurn(fixture)
  const steeredTurns = fixture.transport.turns.length
  const next = await fixture.post("/session/session_1/prompt_async", { messageID: "msg_c_next", parts: [{ type: "text", text: "next" }] })
  expect(next.status).toBe(204)
  await until(() => fixture.transport.turns.length === steeredTurns + 1, "the next turn reached the harness")
  await until(() => fixture.host.store.getSession("session_1")?.status !== "busy", "the next turn ended")

  const turns = () => fixture.host.store.getMessages("session_1").map((message) => [message.info.id, message.turnId])
  const expected = [
    ["msg_a_open", "msg_a_open_r"],
    ["msg_a_open_r", "msg_a_open_r"],
    ["msg_b_steer", "msg_a_open_r"],
    ["msg_b_steer_r", "msg_a_open_r"],
    ["msg_a_step", "msg_a_open_r"],
    ["msg_c_next", "msg_c_next_r"],
    ["msg_c_next_r", "msg_c_next_r"],
  ]
  expect(turns()).toEqual(expected)
  expect(fixture.host.store.turnReply("session_1", "msg_a_open")?.info.id).toBe("msg_a_step")
  fixture.host.store.rebuildProjection("session_1")
  expect(turns()).toEqual(expected)
})
