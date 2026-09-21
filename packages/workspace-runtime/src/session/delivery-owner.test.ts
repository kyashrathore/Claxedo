import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "bun:test"
import { SessionRoutes } from "../routes/session"
import { sessionIdle } from "../compat-events"
import type { AgentRuntime, AgentRuntimeTurnStartInput } from "@claxedo/agent-sdk-runtime"
import { managedWorkspaceSessionAccessPolicy, type SessionAccessPolicy } from "../session-access-policy"
import { RuntimeStore } from "../store"
import { createSessionDeliveryOwner, type SessionDeliveryStore } from "./delivery-owner"

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
  const opened = new RuntimeStore(root)
  stores.push(opened)
  return opened
}

function root() {
  const created = mkdtempSync(join(tmpdir(), "wr-queued-prompt-"))
  roots.push(created)
  return created
}

function port(runtimeStore: RuntimeStore, directory: string | undefined): SessionDeliveryStore {
  return {
    queuePrompt: (input) => runtimeStore.queuePrompt(input),
    deleteQueuedPrompt: (sessionId, seq) => runtimeStore.deleteQueuedPrompt(sessionId, seq),
    replaceQueuedPromptParts: (sessionId, seq, parts) => runtimeStore.replaceQueuedPromptParts(sessionId, seq, parts),
    listQueuedPrompts: () => runtimeStore.listQueuedPrompts(),
    claimQueuedPromptDelivery: (sessionId, seq, operationId, mode) => runtimeStore.claimQueuedPromptDelivery(sessionId, seq, operationId, mode),
    setQueuedPromptHeld: (sessionId, seq, held) => runtimeStore.setQueuedPromptHeld(sessionId, seq, held),
    completeQueuedPrompt: (sessionId, seq, operationId) => runtimeStore.completeQueuedPrompt(sessionId, seq, operationId),
    settleQueuedPromptDelivery: (sessionId, seq, steering) => runtimeStore.settleQueuedPromptDelivery(sessionId, seq, steering),
    sessionDirectory: () => directory,
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
    system: "be brief", variant: "thinking" },
    actor: { actorId: "actor", actorKind: "human" as const }, author: { id: "public", name: "Yash", kind: "human" as const },
    provenance: "loopback-direct" as const }
}
function owner(runtimeStore: RuntimeStore, options: Partial<Parameters<typeof createSessionDeliveryOwner>[0]> = {}) {
  const created = createSessionDeliveryOwner({ store: () => port(runtimeStore, "/workspace"),
    whenIdle: async () => ({ abandon() {} }), startTurn: async (input) => { input.onDelivery("start") }, ...options })
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
  await until(() => runtimeStore.listQueuedPrompts().length === 0)
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
  await until(() => restarted.listQueuedPrompts().length === 0)
  expect(starts).toEqual(["first", "second"])
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
    expect(runtimeStore.listQueuedPrompts()[0].steering).toMatchObject({ mode: "start", state: "dispatching" })
    await receipt.promise
    input.onDelivery("start")
  }
  const a = owner(runtimeStore, { startTurn }), b = owner(runtimeStore, { startTurn })
  await Promise.all([a.recover(), b.recover()])
  await until(() => calls === 1)
  expect(calls).toBe(1)
  expect(await b.control("session_1", 1, "cancel")).toMatchObject({ status: "provider_owned" })
  receipt.resolve()
  await until(() => runtimeStore.listQueuedPrompts().length === 0)
})

test("restart never reissues normal dispatches or steering with missing receipts", async () => {
  const directory = root(), first = store(directory)
  for (const mode of ["start", "steer"] as const) {
    const row = first.queuePrompt({ sessionId: "session_1", messageId: mode, parts: [], delivery: "queue" })
    first.claimQueuedPromptDelivery(row.sessionId, row.seq, mode, mode)
  }
  first.close()
  const restarted = store(directory)
  let calls = 0
  await owner(restarted, { startTurn: async () => { calls++ } }).recover()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(calls).toBe(0)
  expect(restarted.listQueuedPrompts().map((row) => row.steering?.state)).toEqual(["dispatching", "dispatching"])
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
  expect(runtimeStore.listQueuedPrompts()[0].steering).toMatchObject({ state: "accepted", mode: "steer" })
})

test("unknown dispatch remains pending and cannot be edited, cancelled, or replayed", async () => {
  const runtimeStore = store(root())
  const host = owner(runtimeStore, { startTurn: async () => { throw new Error("connection lost") } })
  expect(await host.steer(submission())).toMatchObject({ status: "unknown", message: "connection lost" })
  for (const action of ["cancel", "hold", { replace: [] }] as const) {
    expect(await host.control("session_1", 1, action as "cancel" | "hold" | { replace: [] })).toMatchObject({ status: "provider_owned" })
  }
  await host.recover()
  expect(host.list("session_1")[0].steering?.state).toBe("unknown")
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
  await until(() => restarted.listQueuedPrompts().length === 0)
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
  await until(() => runtimeStore.listQueuedPrompts().length === 0)
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
  expect(runtimeStore.listQueuedPrompts()).toHaveLength(1)
})

test("a runtime without persistence refuses enqueue instead of keeping a request-only queue", () => {
  const host = createSessionDeliveryOwner({ store: () => undefined, whenIdle: async () => ({ abandon() {} }), startTurn: async () => {} })
  expect(() => host.queue(submission())).toThrow("cannot persist")
})

test("managed recovery reacquires turn authority and keeps its fence until execution finishes", async () => {
  const runtimeStore = store(root()), finished = gate()
  const authority = { managed: true as const, workspaceId: "workspace", orgId: "org", role: "editor" as const }
  const requester = submission()
  runtimeStore.queuePrompt({ sessionId: requester.sessionId, messageId: "managed", parts: requester.body.parts,
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
  const host = SessionRoutes(() => ({} as never), { queuedPrompts: () => port(runtimeStore, "/workspace"), resolveRuntime: () => runtime, sessionAccessPolicy: policy })
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
  runtimeStore.queuePrompt({ sessionId: "session_1", messageId: "denied", parts: [], delivery: "queue", actor: requester.actor, authority, provenance: "relay-replayed" })
  const recovered = SessionRoutes(() => ({} as never), { queuedPrompts: () => port(runtimeStore, "/workspace"), resolveRuntime: () => runtime, sessionAccessPolicy: policy })
  await recovered.recoverQueuedPrompts()
  await until(() => runtimeStore.listQueuedPrompts()[0]?.steering?.state === "rejected")
  expect(starts).toHaveLength(1)
  expect(runtimeStore.listQueuedPrompts()[0].steering?.message).toBe("Access revoked")
  await recovered.dispose()
})

test("a recovered relayed row presents its stored grant in place of a credential; one without a grant is declined where grants are minted", async () => {
  const runtimeStore = store(root())
  const authority = { managed: true as const, workspaceId: "workspace", orgId: "org", role: "editor" as const }
  const requester = submission()
  const grant = "eyJ.queued-grant-token.sig"
  runtimeStore.queuePrompt({ sessionId: "session_1", messageId: "granted", parts: [], delivery: "queue", actor: requester.actor, authority, provenance: "relay-replayed", grant })
  runtimeStore.queuePrompt({ sessionId: "session_1", messageId: "ungranted", parts: [], delivery: "queue", actor: requester.actor, authority, provenance: "relay-replayed" })
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
  const host = SessionRoutes(() => ({} as never), { queuedPrompts: () => port(runtimeStore, "/workspace"), resolveRuntime: () => runtime, sessionAccessPolicy: policy })
  await host.recoverQueuedPrompts()
  await until(() => runtimeStore.listQueuedPrompts().find((row) => row.messageId === "ungranted")?.steering?.state === "rejected")

  expect(starts.map((start) => start.messageId)).toEqual(["granted"])
  expect(acquired).toEqual([expect.objectContaining({ actor: requester.actor, authority, sessionId: "session_1", turnId: "granted", grant })])
  expect(acquired[0]).not.toHaveProperty("credential")
  const declined = runtimeStore.listQueuedPrompts().find((row) => row.messageId === "ungranted")
  expect(declined?.steering?.message).toMatch(/deferred turn grant/)
  expect(runtimeStore.listQueuedPrompts().map((row) => row.messageId)).toEqual(["ungranted"])
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
  runtimeStore.queuePrompt({ sessionId: "session_1", messageId: "local", parts: [], delivery: "queue", provenance: "loopback-direct" })
  runtimeStore.queuePrompt({ sessionId: "session_1", messageId: "legacy", parts: [], delivery: "queue" })
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
  const host = SessionRoutes(() => ({} as never), { queuedPrompts: () => port(runtimeStore, "/workspace"), resolveRuntime: () => runtime, sessionAccessPolicy: policy })
  await host.recoverQueuedPrompts()
  await until(() => starts.length === 1)

  expect(starts.map((start) => start.messageId)).toEqual(["local"])
  expect(starts[0].admission).toBeUndefined()
  expect(acquired).toEqual([])
  expect(runtimeStore.listQueuedPrompts().map((row) => row.messageId)).toEqual(["legacy"])
  await host.dispose()
})

test("restart preserves canonical pending fields, explicit attempt mode, and sequence", async () => {
  const directory = root(), previous = store(directory)
  const requester = submission()
  const row = previous.queuePrompt({ sessionId: requester.sessionId, messageId: requester.body.messageID,
    ...requester.body, delivery: "queue", actor: requester.actor, author: requester.author })
  previous.claimQueuedPromptDelivery(row.sessionId, row.seq, "unconfirmed", "steer")
  const before = previous.listQueuedPrompts()
  expect(before[0].steering?.mode).toBe("steer")
  previous.close()
  const reopened = store(directory)
  expect(reopened.listQueuedPrompts()).toEqual(before)
  expect(reopened.queuePrompt({ sessionId: requester.sessionId, messageId: "next", parts: [], delivery: "queue" }).seq).toBe(row.seq + 1)
})

test("claim checks a concurrent hold and dispatch reads the content actually claimed", async () => {
  const runtimeStore = store(root())
  let claims = 0
  const starts: unknown[] = []
  const host = owner(runtimeStore, {
    store: () => ({ ...port(runtimeStore, "/workspace"),
      claimQueuedPromptDelivery: (sessionId, seq, operationId, mode) => {
        if (++claims === 1) runtimeStore.setQueuedPromptHeld(sessionId, seq, true)
        else runtimeStore.replaceQueuedPromptParts(sessionId, seq, [{ type: "text", text: "edited before claim" }])
        return runtimeStore.claimQueuedPromptDelivery(sessionId, seq, operationId, mode)
      },
    }),
    startTurn: async (input) => { starts.push(input.body.parts); input.onDelivery("start") },
  })
  host.queue(submission())
  await until(() => runtimeStore.listQueuedPrompts()[0]?.held === true)
  expect(starts).toEqual([])
  await host.control("session_1", 1, "release")
  await until(() => runtimeStore.listQueuedPrompts().length === 0)
  expect(starts).toEqual([[{ type: "text", text: "edited before claim" }]])
})

test("another owner cannot overtake an earlier normal dispatch in the same session", async () => {
  const runtimeStore = store(root()), receipt = gate()
  for (const messageId of ["first", "second"]) runtimeStore.queuePrompt({ sessionId: "session_1", messageId, parts: [], delivery: "queue" })
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
  await until(() => runtimeStore.listQueuedPrompts().length === 0)
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
  await until(() => runtimeStore.listQueuedPrompts().length === 0)
  expect(starts[0].origin).toEqual({ provenance: "relay-replayed", actor: requester.actor, authority, grant })
})

test("a relayed row queued without a grant carries an origin without one", async () => {
  const runtimeStore = store(root())
  const authority = { managed: true as const, workspaceId: "workspace", orgId: "org", role: "editor" as const }
  const starts: Array<Parameters<Parameters<typeof createSessionDeliveryOwner>[0]["startTurn"]>[0]> = []
  const host = owner(runtimeStore, { startTurn: async (input) => { starts.push(input); input.onDelivery("start") } })
  host.queue({ ...submission("plain"), authority, provenance: "relay-replayed" })
  await until(() => runtimeStore.listQueuedPrompts().length === 0)
  expect(starts[0].origin).toEqual({ provenance: "relay-replayed", actor: submission().actor, authority })
  expect(starts[0].origin).not.toHaveProperty("grant")
})
