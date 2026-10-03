import { testSessionRoutePorts } from "../test-support/session-core"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBus, type WorkspaceRuntimeEvent } from "../bus"
import { afterEach, expect, test } from "bun:test"
import { SessionRoutes } from "../routes/session"
import type { AgentRuntime, AgentRuntimeTurnStartInput } from "../host/runtime"
import type { SessionHarness } from "@claxedo/agent-runtime-contract"
import { managedWorkspaceSessionAccessPolicy, type SessionAccessPolicy } from "../session-access-policy"
import type { RuntimeStore } from "../store"
import { openTestRuntimeStore } from "../test-support/store"
import { createSessionDeliveryOwner, type SessionDeliveryStore } from "./delivery-owner"
import { sessionIdle } from "../projection/presentation-events"

const testBus = createBus<WorkspaceRuntimeEvent>()

const roots: string[] = []
const stores: RuntimeStore[] = []
const owners: Array<ReturnType<typeof createSessionDeliveryOwner>> = []

afterEach(async () => {
  // Owners first and awaited: one still settling a dispatch would otherwise
  // finish it against a store this loop has already closed.
  for (const owner of owners.splice(0)) await owner.dispose()
  for (const store of stores.splice(0)) store.close()
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

function store(root: string) {
  const opened = openTestRuntimeStore(root)
  stores.push(opened)
  return opened
}

function root() {
  const created = mkdtempSync(join(tmpdir(), "wr-queued-prompt-"))
  roots.push(created)
  return created
}

/** The harness a draft read runs on; no test here reads a draft. */
const HARNESS = (requested: SessionHarness | undefined): SessionHarness => requested ?? { id: "codex", access: "native" }

function port(runtimeStore: RuntimeStore, directory: string | undefined): SessionDeliveryStore {
  return {
    queuePrompt: (input) => runtimeStore.deliveryQueue.queuePrompt(input),
    deleteQueuedPrompt: (sessionId, seq) => runtimeStore.deliveryQueue.deleteQueuedPrompt(sessionId, seq),
    replaceQueuedPromptParts: (sessionId, seq, parts) => runtimeStore.deliveryQueue.replaceQueuedPromptParts(sessionId, seq, parts),
    listQueuedPrompts: () => runtimeStore.deliveryQueue.listQueuedPrompts(),
    claimQueuedPromptDelivery: (sessionId, seq, operationId, mode) => runtimeStore.deliveryQueue.claimQueuedPromptDelivery(sessionId, seq, operationId, mode),
    setQueuedPromptHeld: (sessionId, seq, held) => runtimeStore.deliveryQueue.setQueuedPromptHeld(sessionId, seq, held),
    completeQueuedPrompt: (sessionId, seq, operationId) => runtimeStore.deliveryQueue.completeQueuedPrompt(sessionId, seq, operationId),
    retireSteeredPrompt: (sessionId, messageId) => runtimeStore.deliveryQueue.retireSteeredPrompt(sessionId, messageId),
    settleQueuedPromptDelivery: (sessionId, seq, steering) => runtimeStore.deliveryQueue.settleQueuedPromptDelivery(sessionId, seq, steering),
    sessionDirectory: () => directory,
    sessionArchived: () => false,
    messageSessionId: () => undefined,
  }
}

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
function submission(messageID = "message") {
  return { sessionId: "session_1", body: { messageID, parts: [{ type: "text" as const, text: "then run tests" }],
    agent: "build", model: { providerID: "test", modelID: "fixture" }, permissionMode: "ask", tools: { bash: false },
    system: "be brief", variant: "thinking", serviceTier: "priority" },
    actor: { actorId: "actor", actorKind: "human" as const }, author: { id: "public", name: "Yash", kind: "human" as const },
    provenance: "loopback-direct" as const }
}
function owner(runtimeStore: RuntimeStore, options: Partial<Parameters<typeof createSessionDeliveryOwner>[0]> = {}) {
  const created = createSessionDeliveryOwner({ store: () => port(runtimeStore, "/workspace"),
    whenIdle: async () => ({ abandon() {} }), startTurn: async (input) => { input.onDelivery("start") }, changed: () => {}, ...options })
  owners.push(created)
  return created
}
async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
  if (!condition()) throw new Error("condition never held")
}

test("the runtime owner executes persisted input after the submitting caller returns", async () => {
  const runtimeStore = store(root())
  const idle = gate()
  const starts: unknown[] = []
  const host = owner(runtimeStore, { whenIdle: async () => { await idle.promise; return { abandon() {} } },
    startTurn: async (input) => { starts.push(input); input.onDelivery("start") } })
  const sent = submission()
  host.queue(sent)
  expect(starts).toEqual([])
  idle.resolve()
  await until(() => runtimeStore.deliveryQueue.listQueuedPrompts().length === 0)
  expect(starts).toHaveLength(1)
  // The owner hands the turn the row's origin, not the row: `actor` stays
  // stored for attribution, provenance is what the turn is re-decided on.
  expect(starts[0]).toMatchObject({
    sessionId: sent.sessionId,
    body: { ...sent.body, delivery: "queue" },
    directory: "/workspace",
    author: sent.author,
    origin: { provenance: "loopback-direct" },
  })
})

test("recovery runs unclaimed inputs in FIFO order and preserves their original requester", async () => {
  const directory = root()
  const first = store(directory)
  const waiting = gate()
  const dead = owner(first, { whenIdle: async () => { await waiting.promise; return { abandon() {} } } })
  dead.queue(submission("first")); dead.queue(submission("second")); await dead.dispose(); first.close()
  const restarted = store(directory)
  const starts: string[] = []
  const host = owner(restarted, { startTurn: async (input) => { starts.push(input.body.messageID!); expect(input.origin).toEqual({ provenance: "loopback-direct" }); input.onDelivery("start") } })
  await Promise.all([host.recover(), host.recover()])
  await until(() => restarted.deliveryQueue.listQueuedPrompts().length === 0)
  expect(starts).toEqual(["first", "second"])
})

test.each(["", null])("queue recovery preserves explicit default effort %s through dispatch", async (variant) => {
  const directory = root(), first = store(directory), waiting = gate()
  const dead = owner(first, { whenIdle: async () => { await waiting.promise; return { abandon() {} } } })
  const sent = submission()
  dead.queue({ ...sent, body: { ...sent.body, variant } })
  await dead.dispose()
  first.close()
  const restarted = store(directory)
  expect(restarted.deliveryQueue.listQueuedPrompts()[0].variant).toBe("")
  const starts: unknown[] = []
  const host = owner(restarted, { startTurn: async (input) => { starts.push(input.body); input.onDelivery("start") } })
  await host.recover()
  await until(() => restarted.deliveryQueue.listQueuedPrompts().length === 0)
  expect(starts).toEqual([{ ...sent.body, variant: "", delivery: "queue" }])
})

test("dispatch is durable before calling the harness and competing owners cannot execute twice", async () => {
  const runtimeStore = store(root())
  const never = gate()
  const first = owner(runtimeStore, { whenIdle: async () => { await never.promise; return { abandon() {} } } })
  first.queue(submission()); await first.dispose()
  let calls = 0
  const receipt = gate()
  const startTurn: Parameters<typeof createSessionDeliveryOwner>[0]["startTurn"] = async (input) => {
    calls++
    expect(runtimeStore.deliveryQueue.listQueuedPrompts()[0].steering).toMatchObject({ mode: "start", state: "dispatching" })
    await receipt.promise
    input.onDelivery("start")
  }
  const a = owner(runtimeStore, { startTurn }), b = owner(runtimeStore, { startTurn })
  await Promise.all([a.recover(), b.recover()])
  await until(() => calls === 1)
  expect(calls).toBe(1)
  expect(await b.control("session_1", 1, "cancel")).toMatchObject({ status: "provider_owned" })
  receipt.resolve()
  await until(() => runtimeStore.deliveryQueue.listQueuedPrompts().length === 0)
})

test("restart never reissues normal dispatches or steering with missing receipts", async () => {
  const directory = root(), first = store(directory)
  for (const mode of ["start", "steer"] as const) {
    const row = first.deliveryQueue.queuePrompt({ sessionId: "session_1", messageId: mode, parts: [], delivery: "queue" })
    first.deliveryQueue.claimQueuedPromptDelivery(row.sessionId, row.seq, mode, mode)
  }
  first.close()
  const restarted = store(directory)
  let calls = 0
  await owner(restarted, { startTurn: async () => { calls++ } }).recover()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(calls).toBe(0)
  expect(restarted.deliveryQueue.listQueuedPrompts().map((row) => row.steering?.state)).toEqual(["dispatching", "dispatching"])
})

test("HTTP timeout observes a running steering operation; a second click never resends", async () => {
  const runtimeStore = store(root()), receipt = gate(), idle = gate()
  let calls = 0
  const host = owner(runtimeStore, { whenIdle: async () => { await idle.promise; return { abandon() {} } },
    startTurn: async (input) => { calls++; await receipt.promise; input.onSteeringResult?.({ ok: true }); input.onDelivery("steer") } })
  const first = await host.steer(submission())
  expect(first).toMatchObject({ ok: false, status: "pending" })
  const second = host.control("session_1", 1, "steer")
  receipt.resolve()
  expect(await second).toEqual({ ok: true })
  expect(calls).toBe(1)
  expect(runtimeStore.deliveryQueue.listQueuedPrompts()[0].steering).toMatchObject({ state: "accepted", mode: "steer" })
})

test("a steer the transcript takes in before its call returns is done, and its row is gone", async () => {
  const runtimeStore = store(root())
  const changed: string[] = []
  let host!: ReturnType<typeof owner>
  host = owner(runtimeStore, { changed: (sessionId) => changed.push(sessionId), startTurn: async (input) => {
    host.incorporated("session_1", "message")
    input.onSteeringResult?.({ ok: true })
    input.onDelivery("steer")
  } })
  expect(await host.steer(submission())).toEqual({ ok: true })
  expect(runtimeStore.deliveryQueue.listQueuedPrompts()).toEqual([])
  expect(changed).toEqual(["session_1", "session_1", "session_1"])
})

test("a steer the transcript took in stays done whatever its call reports afterwards", async () => {
  const outcomes = [
    { ok: false, status: "unknown", message: "turn ended before the steer was acknowledged" },
    { ok: false, status: "declined", message: "no active turn" },
  ] as const
  for (const outcome of outcomes) {
    const runtimeStore = store(root())
    let host!: ReturnType<typeof owner>
    host = owner(runtimeStore, { startTurn: async (input) => {
      host.incorporated("session_1", "message")
      input.onSteeringResult?.(outcome)
      input.onDelivery("steer")
    } })
    expect(await host.steer(submission())).toEqual({ ok: true })
    expect(runtimeStore.deliveryQueue.listQueuedPrompts()).toEqual([])
  }
  const runtimeStore = store(root())
  let host!: ReturnType<typeof owner>
  host = owner(runtimeStore, { startTurn: async () => {
    host.incorporated("session_1", "message")
    throw new Error("connection lost after the harness took the input in")
  } })
  expect(await host.steer(submission())).toEqual({ ok: true })
})

test("only a steered row leaves the queue when its message reaches the transcript", async () => {
  const runtimeStore = store(root())
  const host = owner(runtimeStore, { whenIdle: () => new Promise(() => {}) })
  host.queue(submission("waiting"))
  host.incorporated("session_1", "waiting")
  expect(runtimeStore.deliveryQueue.listQueuedPrompts().map((row) => row.messageId)).toEqual(["waiting"])
})

test("unknown dispatch cannot be edited or replayed but can be removed durably", async () => {
  const runtimeStore = store(root())
  const host = owner(runtimeStore, { startTurn: async () => { throw new Error("connection lost") } })
  expect(await host.steer(submission())).toMatchObject({ status: "unknown", message: "connection lost" })
  for (const action of ["hold", { replace: [] }] as const) {
    expect(await host.control("session_1", 1, action as "cancel" | "hold" | { replace: [] })).toMatchObject({ status: "provider_owned" })
  }
  await host.recover()
  expect(host.list("session_1")[0].steering?.state).toBe("unknown")
  expect(await host.control("session_1", 1, "steer")).toMatchObject({ status: "unknown" })
  expect(await host.control("session_1", 1, "cancel")).toEqual({ ok: true })
  expect(runtimeStore.deliveryQueue.listQueuedPrompts()).toEqual([])
  await host.recover()
  expect(host.list("session_1")).toEqual([])
})

test("held state survives restart and replacement releases the original input", async () => {
  const directory = root(), first = store(directory), idle = gate()
  const dead = owner(first, { whenIdle: async () => { await idle.promise; return { abandon() {} } } })
  dead.queue(submission()); await dead.control("session_1", 1, "hold"); await dead.dispose(); first.close()
  const restarted = store(directory)
  const starts: unknown[] = []
  const host = owner(restarted, { startTurn: async (input) => { starts.push(input.body); input.onDelivery("start") } })
  await host.recover()
  expect(host.list("session_1")[0].held).toBe(true)
  expect(starts).toEqual([])
  await host.control("session_1", 1, { replace: [{ type: "text", text: "edited" }] })
  await until(() => restarted.deliveryQueue.listQueuedPrompts().length === 0)
  expect(starts[0]).toMatchObject({ messageID: "message", parts: [{ type: "text", text: "edited" }] })
})

test("cancel while waiting removes only the selected input", async () => {
  const runtimeStore = store(root()), idle = gate()
  const starts: string[] = []
  const host = owner(runtimeStore, { whenIdle: async () => { await idle.promise; return { abandon() {} } },
    startTurn: async (input) => { starts.push(input.body.messageID!); input.onDelivery("start") } })
  host.queue(submission("cancel")); host.queue(submission("keep"))
  await host.control("session_1", 1, "cancel")
  idle.resolve()
  await until(() => runtimeStore.deliveryQueue.listQueuedPrompts().length === 0)
  expect(starts).toEqual(["keep"])
})

test("dispose abandons the idle handoff without deleting or executing durable input", async () => {
  const runtimeStore = store(root()), idle = gate()
  let abandoned = 0, starts = 0
  const host = owner(runtimeStore, { whenIdle: async () => { await idle.promise; return { abandon() { abandoned++ } } }, startTurn: async () => { starts++ } })
  host.queue(submission())
  await new Promise((resolve) => setTimeout(resolve, 0))
  await host.dispose(); idle.resolve()
  await until(() => abandoned === 1)
  expect(starts).toBe(0)
  expect(runtimeStore.deliveryQueue.listQueuedPrompts()).toHaveLength(1)
})

test("a runtime without persistence refuses enqueue instead of keeping a request-only queue", () => {
  const host = createSessionDeliveryOwner({ store: () => undefined, whenIdle: async () => ({ abandon() {} }), startTurn: async () => {}, changed: () => {} })
  expect(() => host.queue(submission())).toThrow("cannot persist")
})

test("managed recovery reacquires turn authority and keeps its fence until execution finishes", async () => {
  const runtimeStore = store(root()), finished = gate()
  const authority = { managed: true as const, workspaceId: "workspace", orgId: "org", role: "editor" as const }
  const requester = submission()
  runtimeStore.deliveryQueue.queuePrompt({ sessionId: requester.sessionId, messageId: "managed", parts: requester.body.parts,
    delivery: "queue", actor: requester.actor, author: requester.author, authority, provenance: "relay-replayed" })
  const starts: AgentRuntimeTurnStartInput[] = []
  const acquired: unknown[] = []
  let released = false, deny = false
  const policy: SessionAccessPolicy = {
    sessionAuthority: "managed-private",
    authorizeSessionStartStatus: () => ({ allowed: false as const, status: 403 as const, code: "startup_not_tested", message: "Startup is not admitted by this fixture" }),
    authorizeSessionStart: () => ({ allowed: false as const, status: 403 as const, code: "startup_not_tested", message: "Startup is not admitted by this fixture" }), authorize: () => ({ allowed: true }), authorizePrefix: () => ({ allowed: true }), filterSessions: (input) => input.sessionIds,
    acquireTurn: (input) => {
      acquired.push(input)
      return deny ? { allowed: false, status: 403, code: "access_revoked", message: "Access revoked" }
        : { allowed: true, turnId: input.turnId, leaseId: "lease", fencingToken: 7, acquiredAt: Date.now(), expiresAt: Date.now() + 60_000 }
    },
    renewTurn: (input) => ({ allowed: true, turnId: input.turnId, leaseId: input.leaseId, fencingToken: input.fencingToken, acquiredAt: Date.now(), expiresAt: Date.now() + 60_000 }),
    releaseTurn: () => { released = true; return { released: true } },
  }
  const runtime = {
    turns: { whenIdle: async () => ({ abandon() {} }), start: async (input: AgentRuntimeTurnStartInput) => {
      starts.push(input)
      input.onAdmitted?.()
      return { sessionId: input.sessionId, userMessageId: input.messageId, assistantMessageId: "reply", delivery: "start",
        prompt: { userMessageId: input.messageId, assistantMessageId: "reply", parts: input.parts, agent: "build", model: { providerID: "test", modelID: "fixture" } } }
    } },
    events: { list: async () => [], subscribe: () => (async function* () { await finished.promise; yield { payload: sessionIdle("session_1") } })() },
  } as unknown as AgentRuntime
  const host = SessionRoutes(async () => runtime, { ...testSessionRoutePorts(testBus), queuedPrompts: () => port(runtimeStore, "/workspace"), requestedSessionHarness: HARNESS, sessionAccessPolicy: policy })
  await host.recoverQueuedPrompts()
  await until(() => starts.length === 1)
  expect(acquired[0]).toMatchObject({ actor: requester.actor, authority, turnId: "managed", sessionId: "session_1" })
  expect(acquired[0]).not.toHaveProperty("credential")
  expect(starts[0].admission?.valid()).toBe(true)
  expect(starts[0].admission?.fencingToken()).toBe(7)
  expect(released).toBe(false)
  let stopped = false
  const stopping = host.dispose().then(() => { stopped = true })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(stopped).toBe(false)
  finished.resolve()
  await stopping
  expect(released).toBe(true)
  deny = true
  runtimeStore.deliveryQueue.queuePrompt({ sessionId: "session_1", messageId: "denied", parts: [], delivery: "queue", actor: requester.actor, authority, provenance: "relay-replayed" })
  const recovered = SessionRoutes(async () => runtime, { ...testSessionRoutePorts(testBus), queuedPrompts: () => port(runtimeStore, "/workspace"), requestedSessionHarness: HARNESS, sessionAccessPolicy: policy })
  await recovered.recoverQueuedPrompts()
  await until(() => runtimeStore.deliveryQueue.listQueuedPrompts()[0]?.steering?.state === "rejected")
  expect(starts).toHaveLength(1)
  expect(runtimeStore.deliveryQueue.listQueuedPrompts()[0].steering?.message).toBe("Access revoked")
  await recovered.dispose()
})

test("a recovered relayed row presents its stored grant in place of a credential; one without a grant is declined where grants are minted", async () => {
  const runtimeStore = store(root())
  const authority = { managed: true as const, workspaceId: "workspace", orgId: "org", role: "editor" as const }
  const requester = submission()
  const grant = "eyJ.queued-grant-token.sig"
  runtimeStore.deliveryQueue.queuePrompt({ sessionId: "session_1", messageId: "granted", parts: [], delivery: "queue", actor: requester.actor, authority, provenance: "relay-replayed", grant })
  runtimeStore.deliveryQueue.queuePrompt({ sessionId: "session_1", messageId: "ungranted", parts: [], delivery: "queue", actor: requester.actor, authority, provenance: "relay-replayed" })
  const starts: AgentRuntimeTurnStartInput[] = []
  const acquired: unknown[] = []
  const policy: SessionAccessPolicy = {
    sessionAuthority: "managed-private",
    authorizeSessionStartStatus: () => ({ allowed: false as const, status: 403 as const, code: "startup_not_tested", message: "Startup is not admitted by this fixture" }),
    authorizeSessionStart: () => ({ allowed: false as const, status: 403 as const, code: "startup_not_tested", message: "Startup is not admitted by this fixture" }),
    authorize: () => ({ allowed: true }), authorizePrefix: () => ({ allowed: true }), filterSessions: (input) => input.sessionIds,
    grantTurn: () => { throw new Error("recovery redeems a grant; it never mints one") },
    acquireTurn: (input) => {
      acquired.push(input)
      return { allowed: true, turnId: input.turnId, leaseId: "lease", fencingToken: 7, acquiredAt: Date.now(), expiresAt: Date.now() + 60_000 }
    },
    renewTurn: (input) => ({ allowed: true, turnId: input.turnId, leaseId: input.leaseId, fencingToken: input.fencingToken, acquiredAt: Date.now(), expiresAt: Date.now() + 60_000 }),
    releaseTurn: () => ({ released: true }),
  }
  const runtime = {
    turns: { whenIdle: async () => ({ abandon() {} }), start: async (input: AgentRuntimeTurnStartInput) => {
      starts.push(input)
      input.onAdmitted?.()
      return { sessionId: input.sessionId, userMessageId: input.messageId, assistantMessageId: "reply", delivery: "start",
        prompt: { userMessageId: input.messageId, assistantMessageId: "reply", parts: input.parts, agent: "build", model: { providerID: "test", modelID: "fixture" } } }
    } },
    events: { list: async () => [], subscribe: () => (async function* () { yield { payload: sessionIdle("session_1") } })() },
  } as unknown as AgentRuntime
  const host = SessionRoutes(async () => runtime, { ...testSessionRoutePorts(testBus), queuedPrompts: () => port(runtimeStore, "/workspace"), requestedSessionHarness: HARNESS, sessionAccessPolicy: policy })
  await host.recoverQueuedPrompts()
  await until(() => runtimeStore.deliveryQueue.listQueuedPrompts().find((row) => row.messageId === "ungranted")?.steering?.state === "rejected")

  expect(starts.map((start) => start.messageId)).toEqual(["granted"])
  expect(acquired).toEqual([expect.objectContaining({ actor: requester.actor, authority, sessionId: "session_1", turnId: "granted", grant })])
  expect(acquired[0]).not.toHaveProperty("credential")
  const declined = runtimeStore.deliveryQueue.listQueuedPrompts().find((row) => row.messageId === "ungranted")
  expect(declined?.steering?.message).toMatch(/deferred turn grant/)
  expect(runtimeStore.deliveryQueue.listQueuedPrompts().map((row) => row.messageId)).toEqual(["ungranted"])
  await host.dispose()
})

test("a local queue continues after restart on the daemon shape, unleased, while a row with no provenance does not", async () => {
  // The desktop daemon is a managed composition serving its own machine user.
  // A prompt they queued is theirs to continue; a row from before provenance
  // was recorded names nobody and is never re-issued.
  const runtimeStore = store(root())
  const acquired: unknown[] = []
  const policy: SessionAccessPolicy = {
    ...managedWorkspaceSessionAccessPolicy({ requireActor: false, authority: {
      authorizeSessionStart: async () => true,
      authorizeSessionStartStatus: async () => true,
      authorizeSessionRead: async () => true,
      authorizeSessionWrite: async () => true,
      authorizeSessionStream: async () => ({ allowed: false, status: 503, code: "unused", message: "unused" }),
      registerSession: async () => true,
      acquireTurn: async (input) => { acquired.push(input); return { allowed: false, status: 503, code: "unused", message: "unused" } },
      renewTurn: async () => ({ allowed: false, status: 503, code: "unused", message: "unused" }),
      releaseTurn: async () => ({ released: false }),
    } }),
  }
  expect(policy.sessionAuthority).toBe("managed-private")
  runtimeStore.deliveryQueue.queuePrompt({ sessionId: "session_1", messageId: "local", parts: [], delivery: "queue", provenance: "loopback-direct" })
  runtimeStore.deliveryQueue.queuePrompt({ sessionId: "session_1", messageId: "legacy", parts: [], delivery: "queue" })
  const starts: AgentRuntimeTurnStartInput[] = []
  const runtime = {
    turns: { whenIdle: async () => ({ abandon() {} }), start: async (input: AgentRuntimeTurnStartInput) => {
      starts.push(input)
      input.onAdmitted?.()
      return { sessionId: input.sessionId, userMessageId: input.messageId, assistantMessageId: "reply", delivery: "start",
        prompt: { userMessageId: input.messageId, assistantMessageId: "reply", parts: input.parts, agent: "build", model: { providerID: "test", modelID: "fixture" } } }
    } },
    events: { list: async () => [], subscribe: () => (async function* () { yield { payload: sessionIdle("session_1") } })() },
  } as unknown as AgentRuntime
  const host = SessionRoutes(async () => runtime, { ...testSessionRoutePorts(testBus), queuedPrompts: () => port(runtimeStore, "/workspace"), requestedSessionHarness: HARNESS, sessionAccessPolicy: policy })
  await host.recoverQueuedPrompts()
  await until(() => starts.length === 1)

  expect(starts.map((start) => start.messageId)).toEqual(["local"])
  expect(starts[0].admission).toBeUndefined()
  expect(acquired).toEqual([])
  expect(runtimeStore.deliveryQueue.listQueuedPrompts().map((row) => row.messageId)).toEqual(["legacy"])
  await host.dispose()
})

test("restart preserves canonical pending fields, explicit attempt mode, and sequence", async () => {
  const directory = root(), previous = store(directory)
  const requester = submission()
  const row = previous.deliveryQueue.queuePrompt({ sessionId: requester.sessionId, messageId: requester.body.messageID,
    ...requester.body, delivery: "queue", actor: requester.actor, author: requester.author })
  previous.deliveryQueue.claimQueuedPromptDelivery(row.sessionId, row.seq, "unconfirmed", "steer")
  const before = previous.deliveryQueue.listQueuedPrompts()
  expect(before[0].steering?.mode).toBe("steer")
  previous.close()
  const reopened = store(directory)
  expect(reopened.deliveryQueue.listQueuedPrompts()).toEqual(before)
  expect(reopened.deliveryQueue.queuePrompt({ sessionId: requester.sessionId, messageId: "next", parts: [], delivery: "queue" }).seq).toBe(row.seq + 1)
})

test("claim checks a concurrent hold and dispatch reads the content actually claimed", async () => {
  const runtimeStore = store(root())
  let claims = 0
  const starts: unknown[] = []
  const host = owner(runtimeStore, {
    store: () => ({ ...port(runtimeStore, "/workspace"),
      claimQueuedPromptDelivery: (sessionId, seq, operationId, mode) => {
        if (++claims === 1) runtimeStore.deliveryQueue.setQueuedPromptHeld(sessionId, seq, true)
        else runtimeStore.deliveryQueue.replaceQueuedPromptParts(sessionId, seq, [{ type: "text", text: "edited before claim" }])
        return runtimeStore.deliveryQueue.claimQueuedPromptDelivery(sessionId, seq, operationId, mode)
      },
    }),
    startTurn: async (input) => { starts.push(input.body.parts); input.onDelivery("start") },
  })
  host.queue(submission())
  await until(() => runtimeStore.deliveryQueue.listQueuedPrompts()[0]?.held === true)
  expect(starts).toEqual([])
  await host.control("session_1", 1, "release")
  await until(() => runtimeStore.deliveryQueue.listQueuedPrompts().length === 0)
  expect(starts).toEqual([[{ type: "text", text: "edited before claim" }]])
})

test("another owner cannot overtake an earlier normal dispatch in the same session", async () => {
  const runtimeStore = store(root()), receipt = gate()
  for (const messageId of ["first", "second"]) runtimeStore.deliveryQueue.queuePrompt({ sessionId: "session_1", messageId, parts: [], delivery: "queue" })
  const calls: string[] = []
  const startTurn: Parameters<typeof createSessionDeliveryOwner>[0]["startTurn"] = async (input) => {
    calls.push(input.body.messageID!)
    if (input.body.messageID === "first") await receipt.promise
    input.onDelivery("start")
  }
  const first = owner(runtimeStore, { startTurn }), second = owner(runtimeStore, { startTurn })
  await first.recover()
  await until(() => calls.length === 1)
  await second.recover()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(calls).toEqual(["first"])
  receipt.resolve()
  await until(() => runtimeStore.deliveryQueue.listQueuedPrompts().length === 0)
  expect(calls).toEqual(["first", "second"])
})

test("an unavailable handoff leaves the queue for the next owner instead of dispatching", async () => {
  const runtimeStore = store(root())
  for (const messageId of ["first", "second"]) {
    runtimeStore.deliveryQueue.queuePrompt({ sessionId: "session_1", messageId, parts: [], delivery: "queue" })
  }
  const calls: string[] = []
  let granted = false
  const host = owner(runtimeStore, {
    // What `turns.whenIdle` resolves once the runtime that owned the admission
    // has shut down: no session was granted, so there is nothing to abandon.
    whenIdle: async () => granted ? { abandon() {} } : { abandon() {}, unavailable: true as const },
    startTurn: async (input) => { calls.push(input.body.messageID!); input.onDelivery("start") },
  })

  await host.recover()
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(calls).toEqual([])
  expect(runtimeStore.deliveryQueue.listQueuedPrompts().map((row) => row.messageId)).toEqual(["first", "second"])

  granted = true
  host.wake("session_1")
  await until(() => runtimeStore.deliveryQueue.listQueuedPrompts().length === 0)
  expect(calls).toEqual(["first", "second"])
})

test("a relayed row's deferred grant reaches the turn as its origin and never the queue listing", async () => {
  const runtimeStore = store(root())
  const grant = "eyJ.queued-grant-token.sig"
  const requester = submission("granted")
  const authority = { managed: true as const, workspaceId: "workspace", orgId: "org", role: "editor" as const }
  const admitted = gate()
  const starts: Array<Parameters<Parameters<typeof createSessionDeliveryOwner>[0]["startTurn"]>[0]> = []
  const host = owner(runtimeStore, {
    whenIdle: async () => { await admitted.promise; return { abandon() {} } },
    startTurn: async (input) => { starts.push(input); input.onDelivery("start") },
  })
  const queued = host.queue({ ...requester, authority, provenance: "relay-replayed", grant })
  expect(queued.grant).toBe(grant)
  expect(JSON.stringify(host.list("session_1"))).not.toContain(grant)
  expect(host.list("session_1")[0]).not.toHaveProperty("grant")
  admitted.resolve()
  await until(() => runtimeStore.deliveryQueue.listQueuedPrompts().length === 0)
  expect(starts[0].origin).toEqual({ provenance: "relay-replayed", actor: requester.actor, authority, grant })
})

test("a relayed row queued without a grant carries an origin without one", async () => {
  const runtimeStore = store(root())
  const authority = { managed: true as const, workspaceId: "workspace", orgId: "org", role: "editor" as const }
  const starts: Array<Parameters<Parameters<typeof createSessionDeliveryOwner>[0]["startTurn"]>[0]> = []
  const host = owner(runtimeStore, { startTurn: async (input) => { starts.push(input); input.onDelivery("start") } })
  host.queue({ ...submission("plain"), authority, provenance: "relay-replayed" })
  await until(() => runtimeStore.deliveryQueue.listQueuedPrompts().length === 0)
  expect(starts[0].origin).toEqual({ provenance: "relay-replayed", actor: submission().actor, authority })
  expect(starts[0].origin).not.toHaveProperty("grant")
})

test("every change to a session's queue is announced for that session once the row reflects it", async () => {
  const runtimeStore = store(root())
  const seen: Array<Array<string | undefined>> = []
  const running = gate()
  let queue!: ReturnType<typeof createSessionDeliveryOwner>
  queue = owner(runtimeStore, {
    changed: (sessionId) => { seen.push(queue.list(sessionId).map((row) => row.steering?.state ?? "queued")) },
    startTurn: async (input) => { await running.promise; input.onDelivery("start") },
  })
  queue.queue(submission())
  await until(() => seen.length === 2)
  running.resolve()
  await until(() => seen.length === 3)
  expect(seen).toEqual([["queued"], ["dispatching"], []])
})

test("the session routes publish each queue change on the workspace bus as the session's whole queue", async () => {
  const runtimeStore = store(root())
  runtimeStore.deliveryQueue.queuePrompt({ sessionId: "session_1", messageId: "local", parts: [], delivery: "queue", provenance: "loopback-direct" })
  const frames: Extract<WorkspaceRuntimeEvent, { type: "session.queue" }>[] = []
  const unsubscribe = testBus.subscribe((event) => { if (event.type === "session.queue") frames.push(event) })
  const runtime = {
    turns: { whenIdle: async () => ({ abandon() {} }), start: async (input: AgentRuntimeTurnStartInput) => {
      input.onAdmitted?.()
      return { sessionId: input.sessionId, userMessageId: input.messageId, assistantMessageId: "reply", delivery: "start",
        prompt: { userMessageId: input.messageId, assistantMessageId: "reply", parts: input.parts, agent: "build", model: { providerID: "test", modelID: "fixture" } } }
    } },
    events: { list: async () => [], subscribe: () => (async function* () { yield { payload: sessionIdle("session_1") } })() },
  } as unknown as AgentRuntime
  const host = SessionRoutes(async () => runtime, { ...testSessionRoutePorts(testBus), queuedPrompts: () => port(runtimeStore, "/workspace"), requestedSessionHarness: HARNESS })
  try {
    await host.recoverQueuedPrompts()
    await until(() => frames.length === 2)
    expect(frames.map((frame) => ({ directory: frame.directory, sessionID: frame.sessionID,
      queue: frame.queue.map((row) => [row.messageId, row.steering?.state]) }))).toEqual([
      { directory: "/workspace", sessionID: "session_1", queue: [["local", "dispatching"]] },
      { directory: "/workspace", sessionID: "session_1", queue: [] },
    ])
  } finally {
    unsubscribe()
    await host.dispose()
  }
})

for (const mode of ["start", "steer"] as const) {
  for (const state of ["dispatching", "accepted", "unknown"] as const) {
    test(`${mode} ${state}: removal respects delivery ownership and survives reopening`, async () => {
      const directory = root()
      const runtimeStore = store(directory)
      const queued = runtimeStore.deliveryQueue.queuePrompt({ sessionId: "session_1", messageId: "remove-me", parts: [], delivery: "queue" })
      runtimeStore.deliveryQueue.claimQueuedPromptDelivery("session_1", queued.seq, "operation", mode)
      if (state !== "dispatching") runtimeStore.deliveryQueue.settleQueuedPromptDelivery("session_1", queued.seq, { operationId: "operation", mode, state })
      const host = owner(runtimeStore)
      expect(await host.control("another_session", queued.seq, "cancel")).toMatchObject({ status: "conflict" })
      expect(await host.control("session_1", queued.seq, "cancel")).toMatchObject(state === "unknown" ? { ok: true } : { status: "provider_owned" })
      await host.dispose()
      runtimeStore.close()
      const reopened = store(directory)
      reopened.recoverBusySessions()
      const settled = { dispatching: ["unknown"], accepted: ["accepted"], unknown: [] } as const
      expect(reopened.deliveryQueue.listQueuedPrompts().map((row) => row.steering?.state)).toEqual([...settled[state]])
    })
  }
  test(`a ${mode} a previous runtime left dispatching is removable after restart recovery`, async () => {
    const directory = root()
    const first = store(directory)
    const queued = first.deliveryQueue.queuePrompt({ sessionId: "session_1", messageId: "orphaned", parts: [], delivery: "queue" })
    first.deliveryQueue.claimQueuedPromptDelivery("session_1", queued.seq, "operation", mode)
    first.close()
    const reopened = store(directory)
    reopened.recoverBusySessions()
    expect(reopened.deliveryQueue.listQueuedPrompts()[0]?.steering).toMatchObject({ operationId: "operation", mode, state: "unknown" })
    const host = owner(reopened)
    expect(await host.control("session_1", queued.seq, "steer")).toMatchObject(mode === "start" ? { status: "provider_owned" } : { status: "unknown" })
    expect(await host.control("session_1", queued.seq, "cancel")).toEqual({ ok: true })
    expect(reopened.deliveryQueue.listQueuedPrompts()).toEqual([])
  })
}

test("removing an uncertain start unblocks the next queued prompt without replaying it", async () => {
  const runtimeStore = store(root())
  const first = runtimeStore.deliveryQueue.queuePrompt({ sessionId: "session_1", messageId: "uncertain", parts: [], delivery: "queue" })
  runtimeStore.deliveryQueue.claimQueuedPromptDelivery("session_1", first.seq, "operation", "start")
  runtimeStore.deliveryQueue.settleQueuedPromptDelivery("session_1", first.seq, { operationId: "operation", mode: "start", state: "unknown" })
  const started: string[] = []
  const host = owner(runtimeStore, { startTurn: async (input) => { started.push(input.body.messageID!); input.onDelivery("start") } })
  host.queue(submission("next"))
  await host.control("session_1", first.seq, "cancel")
  await until(() => runtimeStore.deliveryQueue.listQueuedPrompts().length === 0)
  expect(started).toEqual(["next"])
})
