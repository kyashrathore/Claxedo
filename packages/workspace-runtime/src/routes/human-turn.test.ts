import { afterEach, describe, expect, it } from "bun:test"
import type { GoalCapabilities, RuntimeGoalSnapshot } from "@claxedo/agent-runtime-contract"
import type { HarnessTransport, NativeGoalOperations, TransportCapabilities } from "@claxedo/harness/contract"
import { FakeTransport, type FakeTransportOptions, type FakeTurn } from "@claxedo/session-core/testing"
import { createFakeWorkspaceApp, type FakeWorkspaceApp } from "../test-support/fake-workspace-app"

/**
 * A person's send moves their session when it is admitted, whichever way it is
 * delivered; the turn that later delivers it records nothing of its own.
 *
 * `person` stands in for the boundary's verdict on each request: the embedded
 * host's machine-user mark, read by the real routes and the real store.
 */

const apps: FakeWorkspaceApp[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.dispose()
})

const settle = () => Bun.sleep(25)
const text = (turn: FakeTurn) => {
  const [part] = turn.turn.prompt.parts
  return part?.type === "text" ? part.text : ""
}

async function workspace(transport: () => HarnessTransport) {
  const sender = { person: false }
  const wa = await createFakeWorkspaceApp({
    transport,
    before: (app) => app.use("*", async (c, next) => {
      if (sender.person) c.set("machineUserRequest" as never, true as never)
      await next()
    }),
  })
  apps.push(wa)
  return { wa, sender }
}

const lastHumanTurn = (wa: FakeWorkspaceApp, sessionId: string) =>
  (wa.store().getSession(sessionId) as { time?: { lastHumanTurn?: number } } | null)?.time?.lastHumanTurn

/** A harness whose turn named "hold" runs until released, and that accepts a steer into it. */
function holding(options: FakeTransportOptions = {}) {
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const transport = new FakeTransport({
    ...options,
    turn: async function* (input) {
      if (text(input) === "hold") await held
      yield { type: "finish", sessionId: input.session.binding.sessionId }
    },
    steer: async () => ({ ok: true }),
  })
  return { transport, release }
}

async function busy(wa: FakeWorkspaceApp, transport: FakeTransport, sessionId: string) {
  await wa.createSession(sessionId)
  expect((await wa.json(`/session/${sessionId}/prompt_async`, { parts: [{ type: "text", text: "hold" }] })).status).toBe(204)
  for (let attempt = 0; attempt < 200 && transport.turns.length === 0; attempt++) await settle()
  expect(lastHumanTurn(wa, sessionId)).toBeUndefined()
}

describe("a person's send that starts no turn of its own", () => {
  it("records a queued prompt when it is queued, and not again when the queue delivers it", async () => {
    const { transport, release } = holding()
    const { wa, sender } = await workspace(() => transport)
    await busy(wa, transport, "ses_queue")

    sender.person = true
    const queued = await wa.json("/session/ses_queue/prompt_async", { messageID: "msg_queued", parts: [{ type: "text", text: "next" }], delivery: "queue" })
    expect(await queued.json()).toEqual({ delivery: "queue" })
    const sent = lastHumanTurn(wa, "ses_queue")
    expect(typeof sent).toBe("number")

    sender.person = false
    await settle()
    release()
    for (let attempt = 0; attempt < 200 && transport.turns.length < 2; attempt++) await settle()
    expect(transport.turns.map(text)).toEqual(["hold", "next"])
    expect(lastHumanTurn(wa, "ses_queue")).toBe(sent)
  })

  it("records a steered prompt and an edit to a waiting one, and nothing a caller that is not a person sends", async () => {
    const { transport, release } = holding()
    const { wa, sender } = await workspace(() => transport)
    await busy(wa, transport, "ses_steer")

    const queued = await wa.json("/session/ses_steer/prompt_async", { messageID: "msg_waiting", parts: [{ type: "text", text: "later" }], delivery: "queue" })
    expect(await queued.json()).toEqual({ delivery: "queue" })
    expect((await wa.json("/session/ses_steer/prompt_async", { parts: [{ type: "text", text: "agent steer" }], delivery: "steer" })).status).toBe(200)
    expect(lastHumanTurn(wa, "ses_steer")).toBeUndefined()

    sender.person = true
    const [row] = wa.store().deliveryQueue.listQueuedPrompts()
    expect((await wa.json(`/session/ses_steer/queue/${row.seq}/replace`, { parts: [{ type: "text", text: "edited" }] })).status).toBe(200)
    const edited = lastHumanTurn(wa, "ses_steer")
    expect(typeof edited).toBe("number")

    await settle()
    expect(await (await wa.json("/session/ses_steer/prompt_async", { parts: [{ type: "text", text: "person steer" }], delivery: "steer" })).json()).toEqual({ delivery: "steer" })
    expect(lastHumanTurn(wa, "ses_steer")).toBeGreaterThan(edited!)
    release()
  })

  it("records a Goal the person starts, and not one another caller starts", async () => {
    const goal: RuntimeGoalSnapshot = { sessionId: "ses_goal", objective: "Ship it", status: "active", createdAt: 1, updatedAt: 2 }
    const capabilities: GoalCapabilities = { implemented: true, available: true, actions: ["pause", "resume", "delete"], recovery: "reconcile", optionalFields: [] }
    class GoalTransport extends FakeTransport {
      readonly goals: NativeGoalOperations = {
        read: async () => null,
        start: async (_session, objective) => ({ ok: true, goal: { ...goal, objective } }),
        pause: async () => ({ ok: true, goal }),
        resume: async () => ({ ok: true, goal }),
        stop: async () => ({ ok: true, goal }),
        delete: async () => ({ ok: true, goal: null }),
      }
      override async capabilities(): Promise<TransportCapabilities> {
        return { ...await super.capabilities(), goals: capabilities }
      }
    }
    const { wa, sender } = await workspace(() => new GoalTransport())
    await wa.createSession("ses_goal")
    await wa.createSession("ses_goal_agent")

    expect((await wa.json("/session/ses_goal_agent/goal", { objective: "Run on" })).status).toBe(201)
    sender.person = true
    expect((await wa.json("/session/ses_goal/goal", { objective: "Ship it" })).status).toBe(201)

    expect(typeof lastHumanTurn(wa, "ses_goal")).toBe("number")
    expect(lastHumanTurn(wa, "ses_goal_agent")).toBeUndefined()
  })
})
