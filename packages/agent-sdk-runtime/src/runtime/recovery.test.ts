import { describe, expect, test } from "bun:test"
import type { AgentExecutionBinding, RecoveryOperation } from "@claxedo/agent-runtime-contract"
import { createAgentRuntime } from "../runtime"
import type { AgentHarnessFactory } from "../runtime"
import type { AdapterCancelOutcome, AgentHarnessAdapter } from "../adapter-contract"
import { createRuntimeLifecycle } from "./lifecycle"
import { createRuntimeRecovery } from "./recovery"
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

function fixture(options: { store?: MemoryRuntimeStore; cancels?: Cancellation[]; autoCancel?: AdapterCancelOutcome } = {}) {
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
      if (options.autoCancel) return Promise.resolve(options.autoCancel)
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
