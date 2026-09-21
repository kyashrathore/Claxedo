import { describe, expect, test } from "bun:test"
import type { AgentExecutionBinding, RecoveryOperation } from "@claxedo/agent-runtime-contract"
import { createAgentRuntime } from "../runtime"
import type { AgentHarnessFactory } from "../runtime"
import type { AdapterCancelOutcome, AgentHarnessAdapter } from "../adapter-contract"
import { createRuntimeLifecycle } from "./lifecycle"
import { createRuntimeRecovery } from "./recovery"
import { createRuntimeGoalController } from "./goal-controller"
import { createTurnAdmissions } from "./turn-admission"
import { MemoryRuntimeStore } from "../stores/memory"
import { sessionIdle } from "../compat-events"
import type { AgentRuntimeStreamEvent } from "../index"
import type { AgentRuntimeTurnFinishInput } from "../harnesses/shared/runtime-store"
import { RECOVERY_TEST_CALLER, cancelTurnRequest, submittedOperation } from "../test-utils/cancel-turn"

const BUDGETS = { ackMs: 40, providerQueryMs: 40, gracefulCancelMs: 40, reconcileMs: 40 }

/** A store that can be made to reject authoritative turn writes and repaired again. */
class BreakableStore extends MemoryRuntimeStore {
  broken = false
  override finishTurn(input: AgentRuntimeTurnFinishInput) {
    if (this.broken) throw new Error("authoritative store is unavailable")
    return super.finishTurn(input)
  }
}

type TurnControl = {
  finish: () => void
  fail: (message: string) => void
  events: AsyncIterable<AgentRuntimeStreamEvent>
}

function controlledTurn(sessionId: string): TurnControl {
  let settle!: (error?: string) => void
  const ended = new Promise<string | undefined>((resolve) => { settle = resolve })
  return {
    finish: () => settle(undefined),
    fail: (message) => settle(message),
    events: {
      async *[Symbol.asyncIterator]() {
        const failure = await ended
        if (failure) throw new Error(failure)
        yield sessionIdle(sessionId)
      },
    },
  }
}

type Cancellation = {
  binding: AgentExecutionBinding
  turnId: string
  signal: AbortSignal
  settle: (outcome: AdapterCancelOutcome) => void
}

function fixture(options: { store?: MemoryRuntimeStore; cancels?: Cancellation[]; cancelThrows?: string } = {}) {
  const store = options.store ?? new MemoryRuntimeStore()
  const turns: TurnControl[] = []
  const cancels = options.cancels ?? []
  const adapter: AgentHarnessAdapter = {
    instructionChannel: "none",
    async getSession() { return null },
    async createSession(_directory: string, _title: string | undefined, id?: string) { return { id: id ?? "ses_test" } },
    async updateSession() { return null },
    async getSessionConfig() { return { harness: { id: "pi", access: "native" }, variant: null, agent: "build" } },
    async updateSessionConfig() { return { harness: { id: "pi", access: "native" }, variant: null, agent: null } },
    async deleteSession() {},
    readHarnessCapabilities: () => ({}) as never,
    executeTurn(binding: AgentExecutionBinding) {
      const control = controlledTurn(binding.sessionId)
      turns.push(control)
      return control.events
    },
    async getMessages() { return [] },
    cancelTurn(binding: AgentExecutionBinding, input: { turnId: string; signal: AbortSignal }) {
      if (options.cancelThrows) throw new Error(options.cancelThrows)
      return new Promise<AdapterCancelOutcome>((resolve) => {
        cancels.push({ binding, turnId: input.turnId, signal: input.signal, settle: resolve })
      })
    },
    dispose() {},
  } as unknown as AgentHarnessAdapter
  const factory = { id: "pi", access: "native", create: () => adapter } as unknown as AgentHarnessFactory
  const runtime = createAgentRuntime({ store, harnesses: [factory], recovery: { budgets: BUDGETS } })
  return { runtime, store, turns, cancels }
}

async function openSession(runtime: ReturnType<typeof fixture>["runtime"], id: string) {
  const created = await runtime.sessions.create({ id, workspaceId: "ws", directory: "/repo", harness: { id: "pi", access: "native" } })
  return created.id
}

async function until(condition: () => boolean, label: string) {
  for (let attempt = 0; attempt < 400 && !condition(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  if (!condition()) throw new Error(`condition never held: ${label}`)
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function owner(options: { store?: MemoryRuntimeStore; adapterForSession?: () => Promise<AgentHarnessAdapter> } = {}) {
  const store = options.store ?? new MemoryRuntimeStore()
  store.bindSession({ sessionId: "ses", directory: "/repo", workspaceId: "ws", agentSessionId: "ses" })
  const admissions = createTurnAdmissions(store)
  const published: string[] = []
  const recovery = createRuntimeRecovery({
    store,
    admissions,
    adapterForSession: options.adapterForSession ?? (() => Promise.reject(new Error("no harness in this test"))),
    executionBinding: () => ({ sessionId: "ses", workspaceId: "ws", directory: "/repo", connectionId: "pi:native", upstreamSessionId: "ses" }),
    publish: (event) => published.push(event.payload.type),
    announceIdle: () => published.push("global-idle"),
    budgets: BUDGETS,
  })
  const startTurn = (turnId: string, assistantMessageId: string) => store.startTurn({
    sessionId: "ses", userMessageId: turnId, assistantMessageId,
    agent: "build", model: { providerID: "pi", modelID: "default" }, parts: [],
  })
  return { store, admissions, recovery, published, startTurn }
}

describe("cancelling a turn across an asynchronous boundary", () => {
  test("a cancellation that settles after its turn was replaced cannot finalize or release the replacement", async () => {
    const { runtime, store, turns, cancels } = fixture()
    const sessionId = await openSession(runtime, "ses_race")
    const first = await runtime.turns.start({ sessionId, messageId: "msg_a", text: "first" })

    const cancelling = runtime.recovery.submit(cancelTurnRequest(first.target!), RECOVERY_TEST_CALLER)
    await until(() => cancels.length === 1, "the harness to be asked to cancel A")
    const attempt = submittedOperation(await cancelling)
    expect(attempt.state).toBe("needs_action")

    // A ends on its own while its cancellation is still outstanding, and the
    // session is handed to a replacement turn with its own durable lease.
    turns[0].finish()
    await until(() => store.getSession(sessionId)?.status !== "busy", "A to finish")
    const second = await runtime.turns.start({ sessionId, messageId: "msg_b", text: "second" })
    const replacementLease = second.target!.ownerGeneration
    expect(replacementLease).not.toBe(first.target!.ownerGeneration)

    cancels[0].settle({ execution: "terminal", cleanup: "verified_clear" })
    await tick()

    expect(runtime.recovery.inspect(sessionId).target).toMatchObject({ turnId: "msg_b", ownerGeneration: replacementLease })
    expect(store.getSession(sessionId)?.status).toBe("busy")
    expect(store.acquireTurnLease(sessionId)).toBeUndefined()
    await expect(runtime.turns.start({ sessionId, messageId: "msg_c", text: "third" })).rejects.toThrow("already processing")

    const read = runtime.recovery.read(attempt.operationId, RECOVERY_TEST_CALLER)
    expect(read).toMatchObject({ kind: "operation", operation: { state: "needs_action" } })
    expect((read as { operation: RecoveryOperation }).operation.facts.execution.value).toBe("terminal")

    turns[1].finish()
    await runtime.dispose()
  })

  test("a cancellation naming the turn a lease loss was observed for is refused once that turn ended", async () => {
    const { runtime, store, turns, cancels } = fixture()
    const sessionId = await openSession(runtime, "ses_stale")
    const first = await runtime.turns.start({ sessionId, messageId: "msg_a", text: "first" })
    const observed = first.target!

    turns[0].finish()
    await until(() => store.getSession(sessionId)?.status !== "busy", "A to finish")
    const second = await runtime.turns.start({ sessionId, messageId: "msg_b", text: "second" })

    const outcome = await runtime.recovery.submit(cancelTurnRequest(observed), RECOVERY_TEST_CALLER)

    expect(outcome).toMatchObject({
      kind: "refused",
      refusal: { kind: "generation_conflict", current: { turnId: "msg_b", ownerGeneration: second.target!.ownerGeneration } },
    })
    expect(cancels).toHaveLength(0)
    expect(store.getSession(sessionId)?.status).toBe("busy")
    turns[1].finish()
    await runtime.dispose()
  })

  test("a harness that never answers yields a bounded operation whose error is inspectable", async () => {
    const { runtime, turns, cancels } = fixture()
    const sessionId = await openSession(runtime, "ses_wedged")
    const started = await runtime.turns.start({ sessionId, messageId: "msg_a", text: "first" })

    const operation = submittedOperation(await runtime.recovery.submit(cancelTurnRequest(started.target!), RECOVERY_TEST_CALLER))

    expect(operation.state).toBe("needs_action")
    expect(operation.facts.execution.value).toBe("running")
    expect(operation.initiatingError).toMatchObject({ code: "cancellation_timeout", executionMayContinue: true })
    expect(operation.nextActions.map((next) => next.action)).toContain("reconcile_session")
    // The caller stopped waiting; the harness was told so rather than left
    // answering a request nobody holds.
    expect(cancels[0].signal.aborted).toBe(true)
    expect(runtime.recovery.inspect(sessionId).operations).toContainEqual(operation)

    turns[0].finish()
    cancels[0].settle({ execution: "unknown", cleanup: "unknown" })
    await runtime.dispose()
  })

  test("evidence arriving after the deadline corrects the facts without rewriting the attempt", async () => {
    const { runtime, turns, cancels } = fixture()
    const sessionId = await openSession(runtime, "ses_late")
    const started = await runtime.turns.start({ sessionId, messageId: "msg_a", text: "first" })

    const operation = submittedOperation(await runtime.recovery.submit(cancelTurnRequest(started.target!), RECOVERY_TEST_CALLER))
    expect(operation.state).toBe("needs_action")

    cancels[0].settle({ execution: "terminal", cleanup: "verified_clear" })
    await tick()

    const read = runtime.recovery.read(operation.operationId, RECOVERY_TEST_CALLER)
    expect(read).toMatchObject({ kind: "operation", operation: { state: "needs_action" } })
    expect((read as { operation: RecoveryOperation }).operation.facts).toMatchObject({
      execution: { value: "terminal" },
      cleanup: { value: "verified_clear" },
    })

    turns[0].finish()
    await runtime.dispose()
  })
})

describe("a finalization the store refused", () => {
  test("stays owned and inspectable, and one reconciliation finishes the same turn once", async () => {
    const store = new BreakableStore()
    const { runtime, turns } = fixture({ store })
    const sessionId = await openSession(runtime, "ses_unwritable")
    const terminals: string[] = []
    const subscription = runtime.events.subscribe({ sessionId })
    void (async () => {
      for await (const event of subscription) {
        if (event.payload.type === "session.error") terminals.push(event.payload.properties.error?.data.message ?? "")
      }
    })()
    const started = await runtime.turns.start({ sessionId, messageId: "msg_a", text: "first" })

    store.broken = true
    turns[0].fail("the provider died")
    await until(() => runtime.recovery.inspect(sessionId).failures.length > 0, "the failure to reach the owner")

    const failed = runtime.recovery.inspect(sessionId)
    expect(failed.health).toMatchObject({ status: "degraded", reason: "persistence_unavailable" })
    expect(failed.failures[0]).toMatchObject({ code: "persistence_unavailable", executionMayContinue: true })
    expect(failed.facts.persistence.value).toBe("unavailable")
    expect(failed.target).toMatchObject({ turnId: "msg_a" })
    // The store still records the turn as running, so its lease must not have
    // been handed to anything else.
    expect(store.getSession(sessionId)?.status).toBe("busy")
    expect(store.acquireTurnLease(sessionId)).toBeUndefined()
    expect(terminals).toEqual([])

    store.broken = false
    const reconciled = submittedOperation(await runtime.recovery.submit({
      requestId: "req_reconcile",
      action: "reconcile_session",
      target: failed.target!,
      scopeRevision: "1",
      attempt: 1,
    }, RECOVERY_TEST_CALLER))

    expect(reconciled.state).toBe("succeeded")
    expect(reconciled.facts.persistence.value).toBe("committed")
    expect(runtime.recovery.inspect(sessionId).failures).toEqual([])
    expect(runtime.recovery.inspect(sessionId).health).toEqual({ status: "ok" })
    expect(store.getSession(sessionId)).toMatchObject({
      status: "error",
      lastTurn: { status: "failed", error: "the provider died", assistantMessageId: started.assistantMessageId },
    })
    await tick()
    expect(terminals).toEqual(["the provider died"])

    // The turn is finished, so the session takes a replacement.
    const replacement = await runtime.turns.start({ sessionId, messageId: "msg_b", text: "second" })
    expect(replacement.delivery).toBe("start")
    turns[1].finish()
    await runtime.dispose()
  })

  test("a reconciliation that names a different generation is refused", async () => {
    const store = new BreakableStore()
    const { runtime, turns } = fixture({ store })
    const sessionId = await openSession(runtime, "ses_other_generation")
    const started = await runtime.turns.start({ sessionId, messageId: "msg_a", text: "first" })

    store.broken = true
    turns[0].fail("the provider died")
    await until(() => runtime.recovery.inspect(sessionId).failures.length > 0, "the failure to reach the owner")
    store.broken = false

    const outcome = await runtime.recovery.submit({
      requestId: "req_reconcile",
      action: "reconcile_session",
      target: { ...started.target!, ownerGeneration: "a-lease-from-somewhere-else" },
      scopeRevision: "1",
      attempt: 1,
    }, RECOVERY_TEST_CALLER)

    expect(outcome).toMatchObject({ kind: "refused", refusal: { kind: "generation_conflict" } })
    expect(runtime.recovery.inspect(sessionId).failures).toHaveLength(1)
    await runtime.dispose()
  })
})

describe("finalizing a turn this owner did not admit", () => {
  test("a capture with no generation cannot end a turn the runtime has since admitted", () => {
    const store = new MemoryRuntimeStore()
    store.bindSession({ sessionId: "ses", directory: "/repo", workspaceId: "ws", agentSessionId: "ses" })
    const admissions = createTurnAdmissions(store)
    const published: string[] = []
    const recovery = createRuntimeRecovery({
      store,
      admissions,
      adapterForSession: () => Promise.reject(new Error("no harness in this test")),
      executionBinding: () => { throw new Error("no binding in this test") },
      publish: (event) => published.push(event.payload.type),
      announceIdle: () => published.push("global-idle"),
    })
    // A provider admitted this turn for itself, so the runtime holds no
    // generation or lease that a finalization could be checked against.
    store.startTurn({
      sessionId: "ses",
      userMessageId: "msg_provider",
      assistantMessageId: "asst_provider",
      agent: "build",
      model: { providerID: "pi", modelID: "default" },
      parts: [],
    })
    const capture = recovery.captureStoreTurn("ses", "/repo")
    admissions.claim("ses", { turnId: "msg_runtime", assistantMessageId: "asst_runtime" })

    const result = recovery.finalizeTurn(capture, { status: "cancelled", completedAt: 1, reason: "abort" }, { announceIdle: true })

    expect(result).toEqual({ ok: false, reason: "superseded" })
    expect(store.getSession("ses")?.status).toBe("busy")
    expect(store.getSession("ses")?.lastTurn).toBeUndefined()
    expect(published).toEqual([])
    expect(admissions.active("ses")).toMatchObject({ turnId: "msg_runtime" })
  })
})

describe("reading an owner that is shutting down", () => {
  test("inspection still answers while disposal drains a turn that has not ended", async () => {
    const { runtime, store, turns } = fixture()
    const sessionId = await openSession(runtime, "ses_closing")
    await runtime.turns.start({ sessionId, messageId: "msg_a", text: "first" })

    const disposal = runtime.dispose()
    await tick()

    const inspection = runtime.recovery.inspect(sessionId)
    expect(inspection.target).toMatchObject({ turnId: "msg_a" })
    expect(inspection.facts.execution.value).toBe("running")
    expect(store.getSession(sessionId)?.status).toBe("busy")

    turns[0].finish()
    await disposal
    expect(runtime.recovery.inspect(sessionId).facts.execution.value).toBe("terminal")
  })
})

describe("one operation per intent", () => {
  const request = (requestId: string, target: RecoveryOperation["target"], overrides = {}) => ({
    requestId, action: "cancel_turn" as const, target, scopeRevision: "1", attempt: 1, ...overrides,
  })

  test("the same request id twice reads one operation, and a different intent under it conflicts", async () => {
    const { runtime, turns } = fixture()
    const sessionId = await openSession(runtime, "ses_receipts")
    const started = await runtime.turns.start({ sessionId, messageId: "msg_a", text: "first" })

    const first = submittedOperation(await runtime.recovery.submit(request("req_1", started.target!), RECOVERY_TEST_CALLER))
    const repeat = submittedOperation(await runtime.recovery.submit(request("req_1", started.target!), RECOVERY_TEST_CALLER))
    expect(repeat.operationId).toBe(first.operationId)

    const conflict = await runtime.recovery.submit(
      request("req_1", started.target!, { scopeRevision: "2" }),
      RECOVERY_TEST_CALLER,
    )
    expect(conflict).toMatchObject({ kind: "refused", refusal: { kind: "intent_conflict", requestId: "req_1" } })

    turns[0].finish()
    await runtime.dispose()
  })

  test("two callers asking for the same action on the same turn share one operation", async () => {
    const { runtime, turns, cancels } = fixture()
    const sessionId = await openSession(runtime, "ses_coalesce")
    const started = await runtime.turns.start({ sessionId, messageId: "msg_a", text: "first" })

    const first = runtime.recovery.submit(request("req_1", started.target!), RECOVERY_TEST_CALLER)
    await until(() => cancels.length === 1, "the harness to be asked to cancel")
    const joined = submittedOperation(await runtime.recovery.submit(
      request("req_2", started.target!),
      { callerId: "another-caller", authority: "session" },
    ))

    expect(joined.operationId).toBe(submittedOperation(await first).operationId)
    // One controller for one turn generation: the second caller received a
    // receipt, not a second cancellation.
    expect(cancels).toHaveLength(1)

    turns[0].finish()
    cancels[0].settle({ execution: "unknown", cleanup: "unknown" })
    await runtime.dispose()
  })
})

describe("the queue a recovery operation holds", () => {
  test("a recovering session neither wakes its own waiters nor touches another session", async () => {
    const acquired = new Set<string>()
    const store = {
      acquireTurnLease: (sessionId: string) => acquired.has(sessionId) ? undefined : (acquired.add(sessionId), `lease:${sessionId}`),
      releaseTurnLease: (sessionId: string) => { acquired.delete(sessionId) },
    }
    const admissions = createTurnAdmissions(store)
    const woken: string[] = []
    const claimed = admissions.claim("a", { turnId: "msg_a", assistantMessageId: "asst_a" })!
    const otherClaim = admissions.claim("b", { turnId: "msg_b", assistantMessageId: "asst_b" })!
    void admissions.whenIdle("a").then(() => woken.push("a-waiter"))
    void admissions.whenIdle("b").then(() => woken.push("b-waiter"))

    const gate = admissions.gate("a")!
    expect(admissions.gate("a")).toBeUndefined()
    claimed.release()
    await tick()

    expect(woken).toEqual([])
    expect(admissions.queued("a")).toBe(1)
    expect(admissions.claim("a", { turnId: "msg_a2", assistantMessageId: "asst_a2" })).toBeUndefined()

    otherClaim.release()
    await tick()
    expect(woken).toEqual(["b-waiter"])
    expect(admissions.queued("b")).toBe(0)

    gate.release()
    await tick()
    expect(woken).toEqual(["b-waiter", "a-waiter"])
  })

  test("a waiter whose lease acquisition fails hands the session to the next one", async () => {
    let refuse = false
    const store = {
      acquireTurnLease: (sessionId: string) => refuse ? undefined : `lease:${sessionId}`,
      releaseTurnLease: () => {},
    }
    const admissions = createTurnAdmissions(store)
    const woken: string[] = []
    const claimed = admissions.claim("a", { turnId: "msg_a", assistantMessageId: "asst_a" })!
    void admissions.whenIdle("a").then(() => woken.push("first"))
    void admissions.whenIdle("a").then(() => woken.push("second"))

    claimed.release()
    await tick()
    expect(woken).toEqual(["first"])

    refuse = true
    expect(admissions.claim("a", { turnId: "msg_b", assistantMessageId: "asst_b" })).toBeUndefined()
    await tick()

    // Nothing is stranded: the refused waiter's grant was given up rather than
    // left holding a session no prompt can claim.
    expect(woken).toEqual(["first", "second"])
    refuse = false
    expect(admissions.claim("a", { turnId: "msg_c", assistantMessageId: "asst_c" })).toBeDefined()
  })

  test("shutdown settles parked prompts as unavailable instead of handing out a token", async () => {
    const admissions = createTurnAdmissions({ acquireTurnLease: () => "lease", releaseTurnLease: () => {} })
    admissions.claim("a", { turnId: "msg_a", assistantMessageId: "asst_a" })
    const parked = admissions.whenIdle("a")

    admissions.clear()

    expect(await parked).toMatchObject({ unavailable: true })
  })
})

describe("disposal", () => {
  test("reports an immediately failing teardown without waiting for a task that never drains", async () => {
    const reported: unknown[] = []
    const lifecycle = createRuntimeLifecycle({ onTeardownFailure: (error) => reported.push(error) })
    let releaseTask!: () => void
    void lifecycle.track(() => new Promise<void>((resolve) => { releaseTask = resolve }))

    const result = await lifecycle.dispose(
      () => Promise.reject(new Error("the harness would not stop")),
      () => reported.push("cleanup"),
    )

    expect(result).toMatchObject({ ok: false, error: new Error("the harness would not stop") })
    // Reported and returned while the tracked operation is still running, and
    // cleanup has deliberately not run over it.
    expect(reported).toEqual([new Error("the harness would not stop")])
    releaseTask()
    await until(() => reported.length === 2, "cleanup to run once the task drains")
    expect(reported[1]).toBe("cleanup")
  })

  test("a clean teardown drains first and then cleans up", async () => {
    const order: string[] = []
    const lifecycle = createRuntimeLifecycle({ onTeardownFailure: () => order.push("reported") })
    let releaseTask!: () => void
    void lifecycle.track(() => new Promise<void>((resolve) => { releaseTask = resolve }).then(() => { order.push("drained") }))

    const disposal = lifecycle.dispose(async () => order.push("stopped"), () => order.push("cleaned"))
    await tick()
    expect(order).toEqual(["stopped"])

    releaseTask()
    expect(await disposal).toEqual({ ok: true })
    expect(order).toEqual(["stopped", "drained", "cleaned"])
  })
})

describe("the authority a finalization must hold", () => {
  test("a capture whose generation was replaced is refused as superseded, not as a lost lease", () => {
    const { store, admissions, recovery, startTurn } = owner()
    const first = admissions.claim("ses", { turnId: "msg_a", assistantMessageId: "asst_a" })!
    const capture = recovery.captureTurn("ses", first)
    startTurn("msg_a", "asst_a")
    first.release()
    admissions.claim("ses", { turnId: "msg_b", assistantMessageId: "asst_b" })
    startTurn("msg_b", "asst_b")

    // The in-process generation is what rejects this, ahead of the store's
    // lease fence; a `authority_lost` here would mean the check never ran.
    expect(recovery.finalizeTurn(capture, { status: "cancelled", completedAt: 1, reason: "abort" }))
      .toEqual({ ok: false, reason: "superseded" })
    expect(store.getSession("ses")?.status).toBe("busy")
  })

  test("a store turn this owner holds no lease for is refused rather than written unfenced", () => {
    const { store, recovery, published, startTurn } = owner()
    startTurn("msg_provider", "asst_provider")

    recovery.cancelActiveTurn(recovery.captureStoreTurn("ses", "/repo"))

    expect(store.getSession("ses")?.status).toBe("busy")
    expect(store.getSession("ses")?.lastTurn).toBeUndefined()
    expect(published).toEqual([])
    expect(recovery.inspect("ses").failures[0]).toMatchObject({ code: "ownership_unverified" })
  })

  test("a store turn this owner does hold the lease for is finalized and the lease released", () => {
    const { store, recovery, published, startTurn } = owner()
    const leaseId = store.acquireTurnLease("ses")!
    startTurn("msg_provider", "asst_provider")

    recovery.cancelActiveTurn(recovery.captureStoreTurn("ses", "/repo"))

    expect(store.getSession("ses")).toMatchObject({ status: null, lastTurn: { status: "cancelled", reason: "abort" } })
    expect(store.readTurnAuthority("ses")).toBeUndefined()
    expect(store.acquireTurnLease("ses")).not.toBe(leaseId)
    expect(published).toContain("global-idle")
    expect(recovery.inspect("ses").failures).toEqual([])
  })

  test("a finalization the store accepted but recorded nothing for does not claim a commit", () => {
    const { store, admissions, recovery, published, startTurn } = owner()
    const claimed = admissions.claim("ses", { turnId: "msg_a", assistantMessageId: "asst_a" })!
    startTurn("msg_a", "asst_a")
    const capture = recovery.captureTurn("ses", claimed)
    // The provider opened a second turn of its own; the store's active turn is
    // no longer the one this capture names, so the write finds nothing to do.
    startTurn("msg_b", "asst_b")

    const result = recovery.finalizeTurn(capture, { status: "cancelled", completedAt: 1, reason: "abort" }, { announceIdle: true })

    expect(result).toEqual({ ok: true, wrote: false })
    expect(store.getSession("ses")?.status).toBe("busy")
    expect(published).toEqual([])
  })
})

describe("a lease that moved to another owner", () => {
  function fenced() {
    let valid = true
    const { runtime, store, turns } = fixture()
    return {
      runtime, store, turns,
      admission: { valid: () => valid, fencingToken: () => 1 },
      revoke: () => { valid = false },
    }
  }

  test("is terminal for this owner: the admission is given up and no retry is advertised", async () => {
    const f = fenced()
    const sessionId = await openSession(f.runtime, "ses_revoked")
    const started = await f.runtime.turns.start({ sessionId, messageId: "msg_a", text: "first", admission: f.admission })

    f.revoke()
    f.turns[0].finish()
    await until(() => f.runtime.recovery.inspect(sessionId).failures.length > 0, "the lost authority to be reported")

    const inspection = f.runtime.recovery.inspect(sessionId)
    expect(inspection.failures[0]).toMatchObject({ code: "authority_lost", executionMayContinue: true })
    // The lease belongs to whoever fenced this one out, so the admission slot
    // it was still holding is released rather than kept for a retry.
    expect(inspection.target).toBeUndefined()

    const reconciled = submittedOperation(await f.runtime.recovery.submit({
      requestId: "req_reconcile", action: "reconcile_session", target: started.target!, scopeRevision: "1", attempt: 1,
    }, RECOVERY_TEST_CALLER))

    expect(reconciled.state).toBe("failed")
    expect(reconciled.initiatingError).toMatchObject({ code: "authority_lost" })
    expect(reconciled.nextActions.map((next) => next.action)).toEqual(["inspect"])
    await f.runtime.dispose()
  })
})

describe("an operation that throws", () => {
  test("answers its caller, closes, and does not capture the next request for that turn", async () => {
    const { runtime, turns } = fixture({ cancelThrows: "the harness blew up on the way in" })
    const sessionId = await openSession(runtime, "ses_throwing")
    const started = await runtime.turns.start({ sessionId, messageId: "msg_a", text: "first" })

    const first = submittedOperation(await runtime.recovery.submit(cancelTurnRequest(started.target!), RECOVERY_TEST_CALLER))

    expect(first.state).toBe("failed")
    expect(first.initiatingError).toMatchObject({ code: "internal_error", message: expect.stringContaining("blew up") })

    // A second request must open its own operation; coalescing onto an attempt
    // that never closes is how one throw silences every later cancellation.
    const second = submittedOperation(await runtime.recovery.submit(cancelTurnRequest(started.target!), RECOVERY_TEST_CALLER))
    expect(second.operationId).not.toBe(first.operationId)
    expect(second.state).toBe("failed")

    // And the gate it took is back, so the session still admits work.
    turns[0].finish()
    await until(() => runtime.recovery.inspect(sessionId).target === undefined, "the turn to end")
    await runtime.dispose()
  })
})

describe("receipts the store already holds", () => {
  class AdoptingStore extends MemoryRuntimeStore {
    existing?: RecoveryOperation
    override recordRecoveryOperation(operation: RecoveryOperation, caller: { callerId: string }) {
      if (this.existing) return { created: false as const, existing: this.existing }
      return super.recordRecoveryOperation(operation, caller)
    }
  }

  test("an operation another owner already accepted is adopted instead of run again", async () => {
    const store = new AdoptingStore()
    const { runtime, turns, cancels } = fixture({ store })
    const sessionId = await openSession(runtime, "ses_adopt")
    const started = await runtime.turns.start({ sessionId, messageId: "msg_a", text: "first" })
    const request = cancelTurnRequest(started.target!, { requestId: "req_shared" })
    store.existing = {
      operationId: "rop_elsewhere", requestId: "req_shared", target: started.target!, action: "cancel_turn",
      scopeRevision: "1", attempt: 1, state: "running", phase: "graceful_cancel", phaseDeadlineAt: 1,
      facts: runtime.recovery.inspect(sessionId).facts, cleanupErrors: [], nextActions: [],
      receipt: "durable", createdAt: 1, updatedAt: 1,
    }

    const outcome = submittedOperation(await runtime.recovery.submit(request, RECOVERY_TEST_CALLER))

    expect(outcome.operationId).toBe("rop_elsewhere")
    expect(cancels).toHaveLength(0)
    expect(runtime.recovery.read("rop_elsewhere", RECOVERY_TEST_CALLER)).toMatchObject({ kind: "operation" })

    turns[0].finish()
    await runtime.dispose()
  })

  test("a stored receipt under the same request id but a different intent conflicts", async () => {
    const store = new AdoptingStore()
    const { runtime, turns } = fixture({ store })
    const sessionId = await openSession(runtime, "ses_adopt_conflict")
    const started = await runtime.turns.start({ sessionId, messageId: "msg_a", text: "first" })
    store.existing = {
      operationId: "rop_elsewhere", requestId: "req_shared", target: started.target!, action: "cancel_turn",
      scopeRevision: "an-older-scope", attempt: 1, state: "running", phase: "graceful_cancel", phaseDeadlineAt: 1,
      facts: runtime.recovery.inspect(sessionId).facts, cleanupErrors: [], nextActions: [],
      receipt: "durable", createdAt: 1, updatedAt: 1,
    }

    const outcome = await runtime.recovery.submit(
      cancelTurnRequest(started.target!, { requestId: "req_shared" }),
      RECOVERY_TEST_CALLER,
    )

    expect(outcome).toMatchObject({ kind: "refused", refusal: { kind: "intent_conflict", requestId: "req_shared" } })
    turns[0].finish()
    await runtime.dispose()
  })
})

describe("who may read and act", () => {
  test("an operation is only readable by a caller it was accepted for", async () => {
    const { runtime, turns } = fixture()
    const sessionId = await openSession(runtime, "ses_reads")
    const started = await runtime.turns.start({ sessionId, messageId: "msg_a", text: "first" })
    const operation = submittedOperation(await runtime.recovery.submit(cancelTurnRequest(started.target!), RECOVERY_TEST_CALLER))

    expect(runtime.recovery.read(operation.operationId, { callerId: "someone-else", authority: "session" }))
      .toMatchObject({ kind: "refused", refusal: { kind: "unauthorized" } })
    // An operation this owner never recorded cannot be authorized at all, so it
    // is not answered rather than handed over.
    expect(runtime.recovery.read("rop_never_seen", RECOVERY_TEST_CALLER)).toBeUndefined()

    turns[0].finish()
    await runtime.dispose()
  })

  test("a session-scoped caller cannot act on a machine", async () => {
    const { runtime } = fixture()
    await openSession(runtime, "ses_scope")

    const outcome = await runtime.recovery.submit({
      requestId: "req_drain", action: "drain_daemon", scopeRevision: "1", attempt: 1,
      target: { scope: "machine", machineId: "this-one", ownerGeneration: "gen" },
    }, RECOVERY_TEST_CALLER)

    expect(outcome).toMatchObject({ kind: "refused", refusal: { kind: "unauthorized" } })
    await runtime.dispose()
  })
})

describe("what a session's inspection lists", () => {
  class ListingStore extends MemoryRuntimeStore {
    stored: RecoveryOperation[] = []
    throws = false
    override listRecoveryOperations(scope: { sessionId?: string }) {
      if (this.throws) throw new Error("the operations table is unreadable")
      return [...super.listRecoveryOperations(scope), ...this.stored]
    }
  }

  test("operations this owner never recorded, and a store that cannot answer", async () => {
    const store = new ListingStore()
    const { runtime, turns } = fixture({ store })
    const sessionId = await openSession(runtime, "ses_listing")
    const started = await runtime.turns.start({ sessionId, messageId: "msg_a", text: "first" })
    store.stored = [{
      operationId: "rop_before_restart", requestId: "req_old", target: started.target!, action: "cancel_turn",
      scopeRevision: "1", attempt: 1, state: "needs_action", phase: "graceful_cancel", phaseDeadlineAt: 1,
      facts: runtime.recovery.inspect(sessionId).facts, cleanupErrors: [], nextActions: [],
      receipt: "durable", createdAt: 1, updatedAt: 1,
    }]

    expect(runtime.recovery.inspect(sessionId).operations.map((row) => row.operationId)).toContain("rop_before_restart")

    store.throws = true
    const unreadable = runtime.recovery.inspect(sessionId)
    expect(unreadable.operations).toEqual([])
    expect(unreadable.failures).toContainEqual(expect.objectContaining({ code: "persistence_unavailable" }))

    turns[0].finish()
    await runtime.dispose()
  })
})

describe("a Goal mutation that outlives the turn it stops", () => {
  function goalController(stop: () => Promise<void>, resolveHarness: () => Promise<void> = () => Promise.resolve()) {
    const held = owner()
    const goals = {
      readCapabilities: () => ({ implemented: true, available: true, actions: [], recovery: "blocked" as const, optionalFields: [] }),
      read: async () => null,
      start: async () => ({ ok: true as const, goal: null }),
      pause: async () => ({ ok: true as const, goal: null }),
      resume: async () => ({ ok: true as const, goal: null }),
      delete: async () => ({ ok: true as const, goal: null }),
      stop: async () => { await stop(); return { ok: true as const, goal: null } },
    }
    const controller = createRuntimeGoalController({
      store: held.store,
      adapterForSession: async () => {
        await resolveHarness()
        return { readHarnessCapabilities: () => ({ harness: "pi" }), goals } as unknown as AgentHarnessAdapter
      },
      publish: () => {},
      subscribeRuntime: () => () => {},
      captureTurn: held.recovery.captureSessionTurn,
      cancelCapturedTurn: held.recovery.cancelActiveTurn,
    })
    return { ...held, controller }
  }

  // The mutation yields twice before its effect: once resolving the harness and
  // once inside the provider's own stop. A capture taken after either of them
  // can already be the replacement turn.
  test.each(["harness", "provider"] as const)("finalizes the turn it was asked about across the %s await", async (stage) => {
    let release!: () => void
    const reached = new Promise<void>((resolve) => { release = () => resolve() })
    let openGate!: () => void
    const gate = new Promise<void>((resolve) => { openGate = resolve })
    const held = stage === "provider"
      ? goalController(() => { release(); return gate })
      : goalController(() => Promise.resolve(), () => { release(); return gate })
    const first = held.admissions.claim("ses", { turnId: "msg_a", assistantMessageId: "asst_a" })!
    held.startTurn("msg_a", "asst_a")

    const stopping = held.controller.resource.stop("ses", "/repo")
    await reached

    // The Goal turn ends and the session takes a new one while the provider is
    // still working through the stop this caller asked for.
    held.store.finishTurn({ sessionId: "ses", assistantMessageId: "asst_a", outcome: { status: "completed", completedAt: 1 }, leaseId: first.leaseId })
    first.release()
    const second = held.admissions.claim("ses", { turnId: "msg_b", assistantMessageId: "asst_b" })!
    held.startTurn("msg_b", "asst_b")

    openGate()
    await stopping

    expect(held.store.getSession("ses")?.status).toBe("busy")
    expect(held.store.getSession("ses")?.lastTurn).toMatchObject({ assistantMessageId: "asst_a", status: "completed" })
    expect(held.admissions.active("ses")?.generation).toBe(second.generation)
    expect(held.store.readTurnAuthority("ses")?.leaseId).toBe(second.leaseId)
    expect(held.published).toEqual([])
  })
})

describe("two callers naming one turn", () => {
  test("meet on the same operation even when their write authority differs", async () => {
    const { runtime, turns, cancels } = fixture()
    const sessionId = await openSession(runtime, "ses_authority")
    const started = await runtime.turns.start({ sessionId, messageId: "msg_a", text: "first" })

    const first = runtime.recovery.submit(
      cancelTurnRequest({ ...started.target!, writeAuthority: "7" }),
      RECOVERY_TEST_CALLER,
    )
    await until(() => cancels.length === 1, "the harness to be asked to cancel")
    // A lease renewed between the two reads names the same turn, so the second
    // caller must join the first operation rather than open its own.
    const second = submittedOperation(await runtime.recovery.submit(
      cancelTurnRequest({ ...started.target!, writeAuthority: "8" }),
      { callerId: "second-caller", authority: "session" },
    ))

    expect(second.operationId).toBe(submittedOperation(await first).operationId)
    expect(cancels).toHaveLength(1)

    turns[0].finish()
    cancels[0].settle({ execution: "unknown", cleanup: "unknown" })
    await runtime.dispose()
  })
})

describe("an operation that outlives the owner that issued it", () => {
  test("is read back by the callers holding its receipt, and by nobody else", async () => {
    const store = new MemoryRuntimeStore()
    const issued = fixture({ store })
    const sessionId = await openSession(issued.runtime, "ses_restart")
    const started = await issued.runtime.turns.start({ sessionId, messageId: "msg_a", text: "first" })
    const issuing = issued.runtime.recovery.submit(cancelTurnRequest(started.target!), RECOVERY_TEST_CALLER)
    await until(() => issued.cancels.length === 1, "the harness to be asked to cancel")
    // A second caller joins the operation already running for that turn, so its
    // receipt has to reach the store as well.
    const joined = { callerId: "joined-caller", authority: "session" as const }
    const shared = submittedOperation(await issued.runtime.recovery.submit(cancelTurnRequest(started.target!), joined))
    const operation = submittedOperation(await issuing)
    expect(shared.operationId).toBe(operation.operationId)
    issued.turns[0].finish()
    issued.cancels[0]?.settle({ execution: "unknown", cleanup: "unknown" })
    await issued.runtime.dispose()

    // A fresh owner over the same store: its in-memory registry is empty, so
    // every answer below comes from the receipts the store kept.
    const restarted = fixture({ store })

    expect(restarted.runtime.recovery.read(operation.operationId, RECOVERY_TEST_CALLER))
      .toMatchObject({ kind: "operation", operation: { operationId: operation.operationId } })
    expect(restarted.runtime.recovery.read(operation.operationId, joined))
      .toMatchObject({ kind: "operation", operation: { operationId: operation.operationId } })
    expect(restarted.runtime.recovery.read(operation.operationId, { callerId: "never-asked", authority: "session" }))
      .toBeUndefined()

    await restarted.runtime.dispose()
  })

  test("an unreadable store answers nothing and reports why, rather than throwing", async () => {
    class UnreadableStore extends MemoryRuntimeStore {
      override readRecoveryOperation(): RecoveryOperation | undefined {
        throw new Error("the operations table is unreadable")
      }
    }
    const { runtime } = fixture({ store: new UnreadableStore() })
    const sessionId = await openSession(runtime, "ses_unreadable")

    expect(runtime.recovery.read("rop_from_before", RECOVERY_TEST_CALLER)).toBeUndefined()
    expect(runtime.recovery.inspect(sessionId).failures)
      .toContainEqual(expect.objectContaining({ code: "persistence_unavailable" }))

    await runtime.dispose()
  })
})

describe("the lease a finalization must carry", () => {
  test("an admission that still owns the session cannot finalize without the lease behind it", () => {
    const { store, admissions, recovery, published, startTurn } = owner()
    const claimed = admissions.claim("ses", { turnId: "msg_a", assistantMessageId: "asst_a" })!
    startTurn("msg_a", "asst_a")
    const held = recovery.captureTurn("ses", claimed)
    // The admission slot is an in-process fact. Without the durable lease
    // behind it there is nothing to fence the write with, and the store is the
    // only thing that can tell this writer from the next one.
    const unleased = {
      sessionId: held.sessionId, turnId: held.turnId, assistantMessageId: held.assistantMessageId,
      admission: held.admission, target: held.target,
    }

    expect(recovery.finalizeTurn(unleased, { status: "cancelled", completedAt: 1, reason: "abort" }))
      .toEqual({ ok: false, reason: "no_authority" })
    expect(store.getSession("ses")?.status).toBe("busy")
    expect(published).toEqual([])
    // The real capture, which carries it, still works.
    expect(recovery.finalizeTurn(held, { status: "cancelled", completedAt: 2, reason: "abort" }))
      .toEqual({ ok: true, wrote: true })
  })
})
