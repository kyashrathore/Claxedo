import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import {
  NO_HARNESS_EFFORT,
  turnStopped,
  type AgentExecutionBinding,
  type CleanupFact,
  type ExecutionFact,
  type RecoveryOutcome,
  type RecoveryTurnTarget,
} from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeRecoveryInspection } from "@claxedo/agent-sdk-runtime"
import type { AgentSession, ConnectionProvider, SessionConfig } from "@claxedo/agent-sdk-runtime"
import type { AgentHarnessAdapter } from "@claxedo/agent-sdk-runtime/adapters"
import { createWorkspaceRuntimeClient } from "./client"
import { loopbackWorkspaceRuntimeExposure } from "./exposure"
import { managedWorkspaceSessionAccessPolicy, type ManagedSessionAuthority } from "./session-access-policy"
import type { RelayHostAuthContext } from "./workspace-host-service-auth"
import { RuntimeStore } from "./store"
import { withWorkspaceTarget } from "./target"
import { createWorkspaceHost } from "./workspace/runtime"
import { CheckpointRoutes } from "./routes/checkpoint"
import { WorkspaceRuntimeRoutes } from "./routes/manifest"
import type { RuntimeSnapshot } from "./routes/config"

const cleanups: Array<() => void | Promise<void>> = []
const roots: string[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

type CancelAnswer = { execution: ExecutionFact; cleanup: CleanupFact }

type WorkspaceOptions = {
  /** `deferred` withholds the harness answer until `answerCancel` is called. */
  cancel?: "immediate" | "deferred"
  /** Admits prompts under a durable route lease, the way a relay-replayed caller does. */
  authority?: ManagedSessionAuthority
}

/**
 * The workspace a recovery caller reaches: a real host on a real store root,
 * its session routes mounted on a real app, and a harness whose turn and
 * cancellation this test drives.
 */
function openWorkspace(input: { directory: string; storeRoot: string; workspaceId?: string } & WorkspaceOptions) {
  const target = { workspaceId: input.workspaceId ?? "workspace-recovery", directory: input.directory }
  const upstream = new Map<string, AgentSession>()
  const configs = new Map<string, SessionConfig>()
  const turnOutcomes: Array<{ sessionId: string; status: string }> = []
  const cancels: Array<{ sessionId: string; turnId: string }> = []
  const stores: RuntimeStore[] = []
  const held = new Map<string, () => void>()
  const starts = new Map<string, () => void>()
  const failing = new Set<string>()
  let answerCancel: ((answer: CancelAnswer) => void) | undefined
  let finishTurnFails = false

  const turnStarted = (sessionId: string) => new Promise<void>((resolve) => starts.set(sessionId, resolve))
  const releaseTurn = (sessionId: string) => {
    held.get(sessionId)?.()
    held.delete(sessionId)
  }

  const capabilities = {
    abort: true, reconnect: false, replay: true, permissions: false, questions: false,
    todos: false, commands: false, fork: false, revert: false, unrevert: false,
    configOptions: false, subagents: false,
  }

  const provider: ConnectionProvider<{ name: string }> = {
    providerKey: "recovery-fixture",
    validateConfig(config) { return config as { name: string } },
    project() { return { label: "recovery", readiness: "ready", capabilities } },
    resolve({ descriptor, directory }) { return { config: { ...descriptor.config, directory } } },
    createAdapter({ descriptor }) {
      const harness = { id: descriptor.connectionId, access: "connection" as const }
      return {
        sessionConfigOwner: "adapter",
        instructionChannel: "none" as const,
        async createSession(_directory, title, id) {
          const sessionId = id ?? "generated"
          upstream.set("upstream-" + sessionId, { id: sessionId, title, directory: input.directory, time: { created: 10, updated: 10 } })
          configs.set(sessionId, { harness, agent: null, variant: null })
          return { id: sessionId, agentSessionId: "upstream-" + sessionId }
        },
        async getSession(binding) { return upstream.get(binding.upstreamSessionId) ?? null },
        async getMessages() { return [] },
        async updateSession(binding, update) {
          const session = upstream.get(binding.upstreamSessionId)
          if (!session) return null
          const next = { ...session, ...update, time: { ...session.time!, ...update.time } }
          upstream.set(binding.upstreamSessionId, next)
          return next
        },
        async deleteSession(binding) { upstream.delete(binding.upstreamSessionId) },
        async getSessionConfig(binding) { return configs.get(binding.sessionId)! },
        async updateSessionConfig(binding, update) {
          const current = configs.get(binding.sessionId)!
          const next: SessionConfig = {
            ...current,
            ...(update.agent !== undefined ? { agent: update.agent } : {}),
            ...(update.harness !== undefined ? { harness: update.harness } : {}),
          }
          configs.set(binding.sessionId, next)
          return next
        },
        async *executeTurn(binding: AgentExecutionBinding) {
          starts.get(binding.sessionId)?.()
          starts.delete(binding.sessionId)
          await new Promise<void>((resolve) => held.set(binding.sessionId, resolve))
          if (failing.delete(binding.sessionId)) throw new Error("the provider died")
          yield { type: "text-delta", delta: "answer" }
          yield { type: "finish", sessionId: binding.sessionId }
        },
        async cancelTurn(binding: AgentExecutionBinding, cancel: { turnId: string }): Promise<CancelAnswer> {
          cancels.push({ sessionId: binding.sessionId, turnId: cancel.turnId })
          if (input.cancel === "deferred") {
            return await new Promise<CancelAnswer>((resolve) => {
              answerCancel = (answer) => { releaseTurn(binding.sessionId); resolve(answer) }
            })
          }
          // The producer is released only after this answer has been
          // finalized, so the interlock under test is the runtime's released
          // admission rather than whichever writer happened to run first.
          setTimeout(() => releaseTurn(binding.sessionId), 0)
          return { execution: "terminal", cleanup: "unknown" }
        },
        readHarnessCapabilities() {
          return { ...capabilities, goals: false, effortLevels: NO_HARNESS_EFFORT, instructionChannel: "none", harness: descriptor.connectionId }
        },
        dispose() {},
      } satisfies AgentHarnessAdapter
    },
  }

  const sessionAccessPolicy = managedWorkspaceSessionAccessPolicy(input.authority ? { authority: input.authority } : {})

  const host = createWorkspaceHost({
    target,
    storeRoot: input.storeRoot,
    connectionProviders: [provider],
    sessionAccessPolicy,
    onTurnOutcome: ({ sessionId, outcome }) => turnOutcomes.push({ sessionId, status: outcome.status }),
    storeFactory: ({ storeRoot }) => {
      const store = new RuntimeStore(storeRoot!)
      stores.push(store)
      const finish = store.finishTurn.bind(store)
      store.finishTurn = (value) => {
        if (finishTurnFails) throw new Error("the runtime store cannot append")
        return finish(value)
      }
      return store
    },
  })
  cleanups.push(() => host.dispose())

  const app = new Hono<{ Variables: RelayHostAuthContext }>()
  if (input.authority) {
    const issued = Math.floor(Date.now() / 1000)
    app.use("*", async (c, next) => {
      c.set("relayHostAuth", {
        iss: "workspace-relay", aud: "workspace-host-service", principal_kind: "user",
        actor_id: "actor_1", actor_kind: "human", org_id: "org_1",
        workspace_id: target.workspaceId, host_id: "host_1", role: "editor", backing: "cloud-vm",
        exp: issued + 600, iat: issued, jti: "jti_1", parent_jti: "rat_1",
      })
      return await next()
    })
  }
  host.mount(app as unknown as Hono, { exposure: loopbackWorkspaceRuntimeExposure() })
  app.route(WorkspaceRuntimeRoutes.checkpoint, CheckpointRoutes({ checkpoint: host.checkpoint, sessionAccessPolicy }))

  const request = async (pathname: string, method = "GET", body?: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    await withWorkspaceTarget(target, () => app.request(
      "http://runtime.test" + pathname + "?directory=" + encodeURIComponent(input.directory),
      { method, headers: { "Content-Type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
    ))

  const client = createWorkspaceRuntimeClient({
    baseUrl: "http://runtime.test",
    directory: input.directory,
    fetch: async (url, init) => await withWorkspaceTarget(target, () => app.request(url.toString(), init)),
  })

  const snapshot: RuntimeSnapshot = {
    version: 4, mcp: {}, auth: {},
    connections: [{ connectionId: "primary", providerKey: "recovery-fixture", configRevision: 1, enabled: true, config: { name: "primary" } }],
    defaultHarness: { kind: "connection", connectionId: "primary" },
  }

  return {
    host, app, request, client, snapshot, target, cancels, turnOutcomes,
    store: () => stores[0]!,
    turnStarted,
    releaseTurn,
    answerCancel: (answer: CancelAnswer) => {
      if (!answerCancel) throw new Error("no cancellation is waiting for an answer")
      answerCancel(answer)
    },
    breakStore: (broken: boolean) => { finishTurnFails = broken },
    failTurn: (sessionId: string) => { failing.add(sessionId) },
  }
}

type Workspace = ReturnType<typeof openWorkspace>

async function fixture(options: WorkspaceOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "recovery-integration-"))
  roots.push(directory)
  const workspace = openWorkspace({ directory, storeRoot: join(directory, "state"), ...options })
  await workspace.host.apply(workspace.snapshot)
  return { ...workspace, directory, storeRoot: join(directory, "state") }
}

/** One turn, admitted and held inside the harness until the test releases it. */
async function startHeldTurn(f: Workspace, sessionId: string, turnId: string) {
  expect((await f.request("/session", "POST", { id: sessionId })).status).toBe(201)
  return await promptHeldTurn(f, sessionId, turnId)
}

async function promptHeldTurn(f: Workspace, sessionId: string, turnId: string) {
  const started = f.turnStarted(sessionId)
  const prompt = f.request(`/session/${sessionId}/message`, "POST", { messageID: turnId, parts: [{ type: "text", text: "run" }] })
  await started
  return { prompt }
}

async function inspect(f: { request: (p: string) => Promise<Response> | Response }, sessionId: string) {
  const response = await f.request(`/session/${sessionId}/recovery`)
  expect(response.status).toBe(200)
  return await response.json() as AgentRuntimeRecoveryInspection
}

function cancelRequest(target: RecoveryTurnTarget, requestId: string) {
  return { requestId, action: "cancel_turn" as const, target, scopeRevision: target.ownerGeneration, attempt: 1 }
}

async function until(ready: () => boolean | Promise<boolean>, what: string, budgetMs = 5_000) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (await ready()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

function journalTypes(store: RuntimeStore, sessionId: string) {
  return (store as unknown as { db: { prepare(sql: string): { all(...params: unknown[]): unknown[] } } }).db
    .prepare("SELECT type FROM runtime_journal WHERE session_id = ? ORDER BY seq ASC")
    .all(sessionId)
    .map((row) => (row as { type: string | null }).type)
}

describe("cancelling a turn through the public route", () => {
  test("a healthy Stop reports the turn stopped, leaves cleanup unproven, and cancels the transcript once", async () => {
    const f = await fixture()
    const { prompt } = await startHeldTurn(f, "ses_stop", "msg_stop")
    const target = (await inspect(f, "ses_stop")).target!
    expect(target).toMatchObject({ scope: "turn", sessionId: "ses_stop", turnId: "msg_stop", workspaceId: "workspace-recovery" })

    const submitted = await f.client.session.recovery.submit({
      sessionID: "ses_stop",
      request: cancelRequest(target, "req_stop"),
    })
    const outcome = submitted.data
    expect(submitted.response.status).toBe(200)
    expect(outcome.kind).toBe("operation")
    if (outcome.kind !== "operation") throw new Error("expected an operation")

    // The turn stopped and was written; the harness never proved its
    // resources were gone, so the command still owes the caller an action.
    expect(turnStopped(outcome)).toBe(true)
    expect(outcome.operation.facts.cleanup.value).toBe("unknown")
    expect(outcome.operation.state).toBe("needs_action")
    expect(f.cancels).toEqual([{ sessionId: "ses_stop", turnId: "msg_stop" }])

    await prompt
    expect(f.store().getSession("ses_stop")).toMatchObject({ status: "idle", lastTurn: { status: "cancelled" } })
    expect(journalTypes(f.store(), "ses_stop").filter((type) => type === "turn.finish")).toHaveLength(1)
  })

  test("a cancellation for a replaced turn is refused against the turn that replaced it, whose lease it never touches", async () => {
    const f = await fixture()
    const { prompt: first } = await startHeldTurn(f, "ses_replace", "msg_a")
    const stale = (await inspect(f, "ses_replace")).target!
    f.releaseTurn("ses_replace")
    await first

    const { prompt: second } = await promptHeldTurn(f, "ses_replace", "msg_b")
    const live = (await inspect(f, "ses_replace")).target!
    expect(live.turnId).toBe("msg_b")
    expect(live.ownerGeneration).not.toBe(stale.ownerGeneration)

    const response = await f.request("/session/ses_replace/recovery", "POST", cancelRequest(stale, "req_stale"))
    expect(response.status).toBe(409)
    const refused = await response.json() as RecoveryOutcome
    expect(refused).toMatchObject({ kind: "refused", refusal: { kind: "generation_conflict", current: { turnId: "msg_b" } } })

    // Nothing about the replacement moved: same lease, same admitted turn,
    // still busy, and its harness was never asked to cancel.
    expect((await inspect(f, "ses_replace")).target).toEqual(live)
    expect(f.store().getSession("ses_replace")?.status).toBe("busy")
    expect(f.cancels).toEqual([])

    f.releaseTurn("ses_replace")
    await second
  })
})

describe("a freeze that cannot drain", () => {
  test("is refused with the turn that blocked it, and takes no checkpoint", async () => {
    const f = await fixture()
    const { prompt } = await startHeldTurn(f, "ses_freeze", "msg_freeze")

    const response = await f.request("/api/wr/checkpoint/freeze", "POST", { policy: "drain", deadlineMs: 50 })
    expect(response.status).toBe(409)
    const blocked = await response.json() as { state: string; blockers: Array<{ sessionId?: string; turnId?: string; reason: string }> }
    expect(blocked.state).toBe("blocked")
    expect(blocked.blockers).toContainEqual(expect.objectContaining({ sessionId: "ses_freeze" }))
    expect((await (await f.request("/api/wr/checkpoint")).json() as { state: string }).state).not.toBe("frozen")

    f.releaseTurn("ses_freeze")
    await prompt
  })
})

describe("a workspace that is closing", () => {
  test("still answers recovery while its own serving path is fenced", async () => {
    const f = await fixture()
    const { prompt } = await startHeldTurn(f, "ses_closing", "msg_closing")
    const target = (await inspect(f, "ses_closing")).target!

    const disposal = f.host.dispose()
    await Promise.resolve()

    expect((await f.request("/session/ses_closing")).status).toBe(503)
    const inspected = await f.request("/session/ses_closing/recovery")
    expect(inspected.status).toBe(200)
    expect((await inspected.json() as AgentRuntimeRecoveryInspection).target).toMatchObject({ turnId: target.turnId })

    f.releaseTurn("ses_closing")
    await prompt.catch(() => undefined)
    await disposal
  })
})

describe("a harness that never answers the cancellation", () => {
  test("bounds the operation, keeps execution running, and lets its late answer correct only the facts", async () => {
    const f = await fixture({ cancel: "deferred" })
    const { prompt } = await startHeldTurn(f, "ses_silent", "msg_silent")
    const target = (await inspect(f, "ses_silent")).target!

    const response = await f.request("/session/ses_silent/recovery", "POST", cancelRequest(target, "req_silent"))
    expect(response.status).toBe(200)
    const outcome = await response.json() as RecoveryOutcome
    if (outcome.kind !== "operation") throw new Error("expected an operation")

    expect(outcome.operation.state).toBe("needs_action")
    expect(outcome.operation.initiatingError).toMatchObject({ code: "cancellation_timeout", executionMayContinue: true })
    expect(outcome.operation.facts.execution.value).toBe("running")
    expect(turnStopped(outcome)).toBe(false)
    expect(outcome.operation.nextActions.map((next) => next.action)).toContain("reconcile_session")
    expect(f.store().getSession("ses_silent")?.status).toBe("busy")

    f.answerCancel({ execution: "terminal", cleanup: "verified_clear" })
    await until(async () => {
      const read = await (await f.request(`/session/ses_silent/recovery/operations/${outcome.operation.operationId}`)).json() as RecoveryOutcome
      return read.kind === "operation" && read.operation.facts.execution.value === "terminal"
    }, "the late harness answer to reach the operation")

    const settled = await (await f.request(`/session/ses_silent/recovery/operations/${outcome.operation.operationId}`)).json() as RecoveryOutcome
    if (settled.kind !== "operation") throw new Error("expected an operation")
    // Later evidence corrects the facts; the attempt that ran out of time is
    // not rewritten into one that succeeded.
    expect(settled.operation.state).toBe("needs_action")
    expect(settled.operation.facts.cleanup.value).toBe("verified_clear")
    expect(settled.operation.initiatingError).toMatchObject({ code: "cancellation_timeout" })

    await prompt
  }, 25_000)
})

describe("a finalization the store refused", () => {
  test("publishes no idle, stays degraded and inspectable, and one reconciliation finishes the same turn", async () => {
    const f = await fixture()
    const { prompt } = await startHeldTurn(f, "ses_unwritable", "msg_unwritable")
    const target = (await inspect(f, "ses_unwritable")).target!

    f.breakStore(true)
    f.failTurn("ses_unwritable")
    f.releaseTurn("ses_unwritable")
    await until(async () => (await inspect(f, "ses_unwritable")).failures.length > 0, "the failure to reach the owner")

    const failed = await inspect(f, "ses_unwritable")
    expect(failed.health).toMatchObject({ status: "degraded", reason: "persistence_unavailable" })
    expect(failed.failures[0]).toMatchObject({ code: "persistence_unavailable", executionMayContinue: true })
    expect(failed.facts.persistence.value).toBe("unavailable")
    expect(failed.target).toMatchObject({ turnId: "msg_unwritable" })
    // Nothing was written, so nothing may claim the turn ended: the session is
    // still busy and its lease is still held.
    expect(f.store().getSession("ses_unwritable")?.status).toBe("busy")
    expect(f.turnOutcomes).toEqual([])
    expect(journalTypes(f.store(), "ses_unwritable").filter((type) => type === "turn.finish")).toHaveLength(0)

    f.breakStore(false)
    const reconciled = await f.client.session.recovery.submit({
      sessionID: "ses_unwritable",
      request: { requestId: "req_reconcile", action: "reconcile_session", target, scopeRevision: target.ownerGeneration, attempt: 1 },
    })
    expect(reconciled.response.status).toBe(200)
    if (reconciled.data.kind !== "operation") throw new Error("expected an operation")
    expect(reconciled.data.operation.state).toBe("succeeded")
    expect(reconciled.data.operation.facts.persistence.value).toBe("committed")

    const repaired = await inspect(f, "ses_unwritable")
    expect(repaired.failures).toEqual([])
    expect(repaired.health).toEqual({ status: "ok" })
    expect(journalTypes(f.store(), "ses_unwritable").filter((type) => type === "turn.finish")).toHaveLength(1)

    await prompt
  })
})

describe("a turn whose route lease was taken away", () => {
  test("is contained under the identity the route captured, and the replacement turn is untouched", async () => {
    const acquired = new Map<string, { leaseId: string; fencingToken: number }>()
    let fencingToken = 0
    const f = await fixture({
      authority: {
        authorizeSessionStart: () => ({ allowed: true }),
        authorizeSessionStartStatus: () => ({ allowed: true }),
        authorizeSessionRead: () => ({ allowed: true }),
        authorizeSessionWrite: () => ({ allowed: true }),
        authorizeSessionStream: () => ({ allowed: true, lease: "stream_1", expiresAt: Date.now() + 600_000 }),
        registerSession: () => ({ allowed: true }),
        acquireTurn: ({ turnId }) => {
          const now = Date.now()
          const lease = { leaseId: `route_lease_${turnId}`, fencingToken: ++fencingToken }
          acquired.set(turnId, lease)
          // The first turn's authority is withdrawn at renewal; the
          // replacement's outlives the test.
          const ttl = turnId === "msg_lost" ? 200 : 600_000
          return { allowed: true, turnId, ...lease, acquiredAt: now, expiresAt: now + ttl }
        },
        renewTurn: ({ turnId }) => turnId === "msg_lost"
          ? { allowed: false, status: 409, code: "session_turn_lease_lost", message: "Another owner holds this turn" }
          : { allowed: true, turnId, ...acquired.get(turnId)!, acquiredAt: Date.now(), expiresAt: Date.now() + 600_000 },
        releaseTurn: () => ({ released: true }),
      },
    })

    expect((await f.request("/session", "POST", { id: "ses_lost" }, {
      "x-claxedo-session-registration-operation": "reservation_1",
    })).status).toBe(201)
    const { prompt: lost } = await promptHeldTurn(f, "ses_lost", "msg_lost")
    const contained = (await inspect(f, "ses_lost")).target!
    expect(contained.turnId).toBe("msg_lost")

    await until(async () => (await inspect(f, "ses_lost")).operations.length > 0, "the lost lease to submit a containment")
    const operations = (await inspect(f, "ses_lost")).operations
    expect(operations).toHaveLength(1)
    expect(operations[0]).toMatchObject({
      action: "cancel_turn",
      target: { turnId: "msg_lost", ownerGeneration: contained.ownerGeneration },
    })
    expect(f.cancels).toEqual([{ sessionId: "ses_lost", turnId: "msg_lost" }])
    await lost.catch(() => undefined)

    const { prompt: replacement } = await promptHeldTurn(f, "ses_lost", "msg_kept")
    const live = (await inspect(f, "ses_lost")).target!
    expect(live.turnId).toBe("msg_kept")
    expect(live.ownerGeneration).not.toBe(contained.ownerGeneration)
    expect(f.store().getSession("ses_lost")?.status).toBe("busy")

    f.releaseTurn("ses_lost")
    await replacement
  })
})

describe("two runtime owners sharing one store root", () => {
  test("answer one request id with one operation, and the second owner hands back its receipt", async () => {
    const f = await fixture()
    const { prompt } = await startHeldTurn(f, "ses_shared", "msg_shared")
    const target = (await inspect(f, "ses_shared")).target!

    const first = await (await f.request("/session/ses_shared/recovery", "POST", cancelRequest(target, "req_shared"))).json() as RecoveryOutcome
    if (first.kind !== "operation") throw new Error("expected an operation")
    await prompt

    const other = openWorkspace({ directory: f.directory, storeRoot: f.storeRoot })
    await other.host.apply(other.snapshot)

    const warm = await startHeldTurn(other, "ses_warm", "msg_warm")
    other.releaseTurn("ses_warm")
    await warm.prompt

    const adopted = await (await other.request("/session/ses_shared/recovery", "POST", cancelRequest(target, "req_shared"))).json() as RecoveryOutcome
    if (adopted.kind !== "operation") throw new Error("expected an operation")
    // One command, not two: the second owner ran nothing and returned the
    // operation the first one already accepted.
    expect(adopted.operation.operationId).toBe(first.operation.operationId)
    expect(other.cancels).toEqual([])

    const receipt = await (await other.request(`/session/ses_shared/recovery/operations/${first.operation.operationId}`)).json() as RecoveryOutcome
    expect(receipt).toMatchObject({ kind: "operation", operation: { operationId: first.operation.operationId, requestId: "req_shared" } })
  })
})

describe("a journal row that cannot be read", () => {
  test("refuses only its own session, and one rebuild repairs that session's projection", async () => {
    const f = await fixture()
    for (const sessionId of ["ses_broken", "ses_intact"]) {
      const { prompt } = await startHeldTurn(f, sessionId, `msg_${sessionId}`)
      f.releaseTurn(sessionId)
      await prompt
    }
    const rows = journalTypes(f.store(), "ses_broken")
    // An event row, not the newest turn row: a session's `lastTurn` is read
    // off the latter on paths that have nothing to do with replay.
    const seq = rows.indexOf("message.completed") + 1
    expect(seq).toBeGreaterThan(0)
    await f.host.dispose()

    const offline = new RuntimeStore(f.storeRoot)
    const db = (offline as unknown as { db: { prepare(sql: string): { run(...p: unknown[]): unknown; get(...p: unknown[]): unknown } } }).db
    const readable = db.prepare("SELECT payload_json FROM runtime_journal WHERE session_id = ? AND seq = ?").get("ses_broken", seq) as { payload_json: string }
    db.prepare("UPDATE runtime_journal SET payload_json = ? WHERE session_id = ? AND seq = ?").run("{not json", "ses_broken", seq)
    db.prepare("UPDATE journal_checkpoint SET last_seq = ? WHERE session_id = ?").run(seq - 1, "ses_broken")
    offline.close()

    const reopened = openWorkspace({ directory: f.directory, storeRoot: f.storeRoot })
    await reopened.host.apply(reopened.snapshot)
    expect(reopened.store().replayJournal("ses_broken").blocked?.seq).toBe(seq)
    expect((await reopened.request("/session/ses_intact")).status).toBe(200)
    expect((await reopened.request("/session/ses_broken/message", "POST", { messageID: "msg_after", parts: [{ type: "text", text: "run" }] })).status).toBe(500)

    // A rebuild repairs a projection, never the journal.
    expect(reopened.store().rebuildProjection("ses_broken")).toMatchObject({ rebuilt: false, blocked: { seq } })
    const live = (reopened.store() as unknown as { db: { prepare(sql: string): { run(...p: unknown[]): unknown } } }).db
    live.prepare("UPDATE runtime_journal SET payload_json = ? WHERE session_id = ? AND seq = ?").run(readable.payload_json, "ses_broken", seq)
    expect(reopened.store().rebuildProjection("ses_broken", "journal repaired").rebuilt).toBe(true)
    expect(reopened.store().getSession("ses_broken")?.status).toBe("idle")
    expect((await reopened.request("/session/ses_broken")).status).toBe(200)
  })
})
