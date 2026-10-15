import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import type { SteerResult } from "@claxedo/agent-runtime-contract"
import { managedWorkspaceSessionAccessPolicy, type SessionRequestIdentity } from "../session-access-policy"
import { testSessionRoutePorts } from "../test-support/session-core"
import { FakeTransport } from "../test-support/fake-transport"
import { createHostFixture, sessionCreate, until } from "../test-support/host-fixture"
import { testLaunch } from "../test-support/host-composition"
import { SessionRoutes } from "./session"
import { queuedPromptStore } from "./session-store-reads"

const cleanups: Array<() => Promise<unknown>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const ACTOR = "actor_owner"
const IDENTITY: SessionRequestIdentity = {
  actor_id: ACTOR, user_id: ACTOR, actor_kind: "human", actor_public_id: ACTOR, actor_name: "workspace owner",
  workspace_id: "ws_1", org_id: "org_1", role: "owner",
}

type Acquisition = { turnId: string; grant?: string; allowed: boolean }

/**
 * The control plane's turn authority as D1 keeps it: one live lease per
 * session, an acquire for another turn refused while it lives, and a deferred
 * grant redeemed once — a second acquire under it is admitted only while the
 * lease it was redeemed for is still live.
 */
function turnAuthority() {
  const leases = new Map<string, { turnId: string; leaseId: string; fencingToken: number; released: boolean }>()
  const grants = new Map<string, { turnId: string; redeemedFor?: string }>()
  const acquisitions: Acquisition[] = []
  const refusals = new Set<string>()
  let fencing = 0
  const live = (sessionId: string) => {
    const lease = leases.get(sessionId)
    return lease && !lease.released ? lease : undefined
  }
  const issue = (sessionId: string, turnId: string) => {
    const lease = { turnId, leaseId: `lease_${turnId}_${++fencing}`, fencingToken: fencing, released: false }
    leases.set(sessionId, lease)
    return { allowed: true as const, turnId, leaseId: lease.leaseId, fencingToken: lease.fencingToken, acquiredAt: Date.now(), expiresAt: Date.now() + 60_000 }
  }
  const policy = managedWorkspaceSessionAccessPolicy({
    requireActor: true,
    authority: {
      authorizeSessionRead: () => true,
      authorizeSessionWrite: () => true,
      authorizeSessionStream: () => ({ allowed: false, status: 503, code: "unused", message: "unused" }),
      registerSession: () => true,
      acquireTurn: ({ sessionId, turnId, grant }) => {
        const current = live(sessionId)
        const issued = grant === undefined ? undefined : grants.get(grant)
        const spent = grant !== undefined && (!issued || issued.turnId !== turnId || (issued.redeemedFor !== undefined && current?.turnId !== turnId))
        const busy = (current !== undefined && current.turnId !== turnId) || refusals.has(turnId)
        acquisitions.push({ turnId, ...(grant ? { grant } : {}), allowed: !spent && !busy })
        if (spent) return { allowed: false, status: 403, code: "session_turn_grant_spent", message: `The grant for ${turnId} was already redeemed` }
        if (busy) return { allowed: false, status: 409, code: "session_turn_in_progress", message: "Session is already processing a turn" }
        if (issued) issued.redeemedFor = turnId
        return issue(sessionId, turnId)
      },
      renewTurn: ({ sessionId, turnId, leaseId, fencingToken }) => {
        const current = live(sessionId)
        if (current?.turnId !== turnId || current.leaseId !== leaseId) return { allowed: false, status: 401, code: "session_turn_lease_invalid", message: "lease is gone" }
        return { allowed: true, turnId, leaseId, fencingToken, acquiredAt: Date.now(), expiresAt: Date.now() + 60_000 }
      },
      releaseTurn: ({ sessionId, turnId }) => {
        const current = live(sessionId)
        if (current?.turnId === turnId) current.released = true
        return { released: current?.turnId === turnId }
      },
    },
  })
  policy.grantTurn = ({ turnId }) => {
    const grant = `grant_${turnId}`
    grants.set(grant, { turnId: turnId! })
    return { allowed: true, grant, expiresAt: Date.now() + 60_000 }
  }
  return {
    policy,
    acquisitions,
    issue,
    live,
    refuse: (turnId: string) => { refusals.add(turnId) },
    admit: (turnId: string) => { refusals.delete(turnId) },
  }
}

/**
 * A session whose opening turn `msg_a` runs until `finishOpening`, taking in a
 * steer when the harness accepts one; every other turn answers at once.
 */
async function queuedSession(input: { steer: "accepts" | "declines" }) {
  const steered: string[] = []
  let incorporate: ((messageId: string) => void) | undefined
  let finishOpening!: () => void
  const opening = new Promise<void>((resolve) => { finishOpening = resolve })
  const transport = new FakeTransport({
    async *turn({ turn }) {
      if (turn.prompt.userMessageId !== "msg_a") {
        yield { type: "text-delta", delta: `answered ${turn.prompt.userMessageId}` }
        yield { type: "finish", sessionId: "session_1" }
        return
      }
      yield { type: "text-delta", delta: "working" }
      const steer = new Promise<string>((resolve) => { incorporate = resolve })
      const next = await Promise.race([steer, opening.then(() => undefined)])
      if (next) yield { type: "input-incorporated", messageId: next }
      await opening
      yield { type: "finish", sessionId: "session_1" }
    },
    steer: async (_session, _turn, turnInput): Promise<SteerResult> => {
      steered.push(turnInput.userMessageId)
      if (input.steer === "declines") return { ok: false, status: "declined", message: "This turn takes no steering" }
      incorporate?.(turnInput.userMessageId)
      return { ok: true }
    },
  })
  const authority = turnAuthority()
  const host = createHostFixture({ transports: { pi: transport }, workspaceId: "ws_1", launch: testLaunch("ws_1", [ACTOR]) })
  const routes = SessionRoutes(async () => host.runtime, {
    ...testSessionRoutePorts(), eventHub: host.eventHub, queuedPrompts: () => queuedPromptStore(host.store),
    sessionAccessPolicy: authority.policy, requestedSessionHarness: (requested) => requested ?? { id: "pi", access: "native" },
  })
  cleanups.push(() => host.dispose(), () => routes.dispose(), async () => finishOpening())
  const app = new Hono()
  app.use("*", async (c, next) => {
    ;(c as unknown as { set(name: string, value: unknown): void }).set("relayHostAuth", IDENTITY)
    await next()
  })
  app.route("/", routes.routes)
  const post = (path: string, body: unknown = {}) => app.request(path, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer relay-host-token" }, body: JSON.stringify(body),
  })
  const queue = async () => await (await app.request("/session/session_1/queue", { headers: { authorization: "Bearer relay-host-token" } }))
    .json() as Array<{ seq: number; messageId: string; steering?: { state: string } }>
  await host.runtime.sessions.create(sessionCreate({ id: "session_1", workspaceId: "ws_1" }))
  const turnIds = () => transport.turns.map((turn) => turn.turn.prompt.userMessageId)
  return { host, routes, authority, steered, finishOpening, post, queue, turnIds }
}

async function openWithQueued(session: Awaited<ReturnType<typeof queuedSession>>) {
  expect((await session.post("/session/session_1/prompt_async", { messageID: "msg_a", parts: [{ type: "text", text: "work" }] })).status).toBe(204)
  await until(() => session.turnIds().length === 1, "the opening turn reached the harness")
  const queued = await session.post("/session/session_1/prompt_async", { messageID: "msg_b", delivery: "queue", parts: [{ type: "text", text: "then this" }] })
  expect(await queued.json()).toEqual({ delivery: "queue" })
  const [row] = await session.queue()
  expect(row?.messageId).toBe("msg_b")
  return row.seq
}

/** Resolves once `read` has answered the same for 100ms: nothing is still on its way. */
async function settled(read: () => unknown) {
  for (let last = read(), stableSince = Date.now(); Date.now() - stableSince < 100;) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    const current = read()
    if (current !== last) { last = current; stableSince = Date.now() }
  }
}

const redeemed = (acquisitions: readonly Acquisition[], turnId: string) =>
  acquisitions.filter((acquisition) => acquisition.turnId === turnId && acquisition.allowed)

describe("Send now and Retry on a relayed queued message", () => {
  test("Send now while a turn runs steers the message into that turn without taking a turn of its own", async () => {
    const session = await queuedSession({ steer: "accepts" })
    const seq = await openWithQueued(session)

    const sent = await session.post(`/session/session_1/queue/${seq}/steer`)

    expect({ status: sent.status, body: await sent.json() }).toEqual({ status: 200, body: { ok: true } })
    expect(session.steered).toEqual(["msg_b"])
    session.finishOpening()
    await until(() => !session.authority.live("session_1"), "the opening turn's lease released")
    await until(() => session.host.store.deliveryQueue.listQueuedPrompts().length === 0, "the steered row left the queue")
    expect(session.turnIds()).toEqual(["msg_a"])
    expect(session.authority.acquisitions.map((acquisition) => acquisition.turnId)).toEqual(["msg_a"])
  })

  test("Send now that the running turn declines runs the message next, as its own turn under its own grant", async () => {
    const session = await queuedSession({ steer: "declines" })
    const seq = await openWithQueued(session)

    const sent = await session.post(`/session/session_1/queue/${seq}/steer`)

    expect(sent.status).toBe(409)
    expect(await sent.json()).toMatchObject({ ok: false, status: "rejected", message: "This turn takes no steering" })
    expect(session.steered).toEqual(["msg_b"])
    session.finishOpening()
    await until(() => session.turnIds().length === 2, "the declined message ran as the next turn")
    await until(() => session.host.store.deliveryQueue.listQueuedPrompts().length === 0, "the row left the queue")
    expect(session.turnIds()).toEqual(["msg_a", "msg_b"])
    expect(redeemed(session.authority.acquisitions, "msg_b")).toEqual([{ turnId: "msg_b", grant: "grant_msg_b", allowed: true }])
  })

  test("Retry on a message the queue could not start runs it now, as its own turn under its own grant", async () => {
    const session = await queuedSession({ steer: "accepts" })
    const seq = await openWithQueued(session)
    session.authority.refuse("msg_b")
    session.finishOpening()
    await until(() => session.host.store.deliveryQueue.listQueuedPrompts()[0]?.steering?.state === "rejected", "the queue's start was refused")
    await settled(() => session.authority.acquisitions.length)
    session.authority.admit("msg_b")
    expect(session.turnIds()).toEqual(["msg_a"])

    const retried = await session.post(`/session/session_1/queue/${seq}/steer`)

    expect({ status: retried.status, body: await retried.json() }).toEqual({ status: 200, body: { ok: true } })
    await until(() => session.turnIds().length === 2, "the retried message ran")
    await until(() => session.host.store.deliveryQueue.listQueuedPrompts().length === 0, "the row left the queue")
    expect(session.turnIds()).toEqual(["msg_a", "msg_b"])
    expect(session.steered).toEqual([])
    expect(redeemed(session.authority.acquisitions, "msg_b")).toEqual([{ turnId: "msg_b", grant: "grant_msg_b", allowed: true }])
  })
})

describe("a turn lease the host took over after it restarted", () => {
  test("holds the queue until it is released, then the queued message runs under its own turn id", async () => {
    const session = await queuedSession({ steer: "accepts" })
    const issued = session.authority.issue("session_1", "msg_resumed")
    const adopted = session.routes.adoptTurnLease({
      access: { actor: { actorId: ACTOR, userId: ACTOR, actorKind: "human" }, authority: { managed: true, workspaceId: "ws_1", orgId: "org_1", role: "owner" },
        operation: "prompt", sessionId: "session_1" },
      lease: issued,
      onLost: () => ({ kind: "refused", refusal: { kind: "unauthorized", message: "lost" } }),
    })
    const queued = await session.post("/session/session_1/prompt_async", { messageID: "msg_b", delivery: "queue", parts: [{ type: "text", text: "after the resumed run" }] })
    expect(await queued.json()).toEqual({ delivery: "queue" })
    await settled(() => session.authority.acquisitions.length)
    expect(session.turnIds()).toEqual([])
    expect(session.authority.acquisitions).toEqual([])

    await adopted.release()

    await until(() => session.turnIds().length === 1, "the queued message ran once the adopted lease was released")
    await until(() => session.host.store.deliveryQueue.listQueuedPrompts().length === 0, "the row left the queue")
    expect(session.turnIds()).toEqual(["msg_b"])
    expect(session.authority.acquisitions).toEqual([{ turnId: "msg_b", grant: "grant_msg_b", allowed: true }])
  })
})
