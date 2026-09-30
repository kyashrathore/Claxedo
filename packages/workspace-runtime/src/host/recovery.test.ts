import { rmSync } from "node:fs"
import { afterEach, describe, expect, test } from "bun:test"
import { RECOVERY_OPERATION_RETENTION_MS, turnStopped } from "@claxedo/agent-runtime-contract"
import type { AdapterCancelOutcome, AgentExecutionBinding, RecoveryOperation } from "@claxedo/agent-runtime-contract"
import type { SessionBroker } from "@claxedo/harness/contract"
import { RuntimeStore, type RuntimeStoreDatabase } from "../store"
import { openRuntimeStoreDatabase } from "../store-file"
import {
  LOOPBACK_ORIGIN,
  MACHINE_OWNER,
  RECOVERY_TEST_CALLER,
  cancelTurnRequest,
  controlledTurn,
  createHostFixture,
  sessionCreate,
  submittedOperation,
  tempStoreRoot,
  tick,
  transportHandle,
  until,
  type HostFixture,
  type TurnControl,
} from "../test-support/host-fixture"
import { createWorkspaceTransports, type WorkspaceTransportsInput } from "../workspace/transports"
import type { RuntimeConnectionDescriptor } from "../routes/config"
import { FakeTransport } from "../test-support/fake-transport"
import type { AttachedSession } from "./attachments"
import { createRuntimeGoalController } from "./goal-controller"
import { createRuntimeLifecycle } from "./lifecycle"
import { createRuntimeRecovery } from "./recovery"
import { createTurnAdmissions } from "./turn-admission"

const BUDGETS = { ackMs: 40, providerQueryMs: 40, gracefulCancelMs: 40, reconcileMs: 40 }

const opened: Array<{ store: RuntimeStore; root: string }> = []

/** A store the test owns: opened in its own root, closed and removed after the test. */
function openStore<T extends RuntimeStore>(Store: new (database: RuntimeStoreDatabase) => T): T {
  const root = tempStoreRoot("host-recovery-")
  const store = new Store(openRuntimeStoreDatabase(root))
  opened.push({ store, root })
  return store
}

afterEach(() => {
  for (const entry of opened.splice(0)) {
    entry.store.close()
    rmSync(entry.root, { recursive: true, force: true })
  }
})

/** A store that can be made to reject authoritative turn writes and repaired again. */
class BreakableStore extends RuntimeStore {
  broken = false
  override finishTurn(input: Parameters<RuntimeStore["finishTurn"]>[0]) {
    if (this.broken) throw new Error("authoritative store is unavailable")
    return super.finishTurn(input)
  }
}

type Cancellation = {
  binding: AgentExecutionBinding
  turnId: string
  signal: AbortSignal
  settle: (outcome: AdapterCancelOutcome) => void
}

function fixture(options: { store?: RuntimeStore; cancels?: Cancellation[]; cancelThrows?: string; now?: () => number } = {}) {
  const turns: TurnControl[] = []
  const cancels = options.cancels ?? []
  const transport = new FakeTransport({
    kind: "pi-rpc",
    turn: (input) => {
      const control = controlledTurn(input.session.binding.sessionId)
      turns.push(control)
      return control.events
    },
    cancel: ({ session, turn, deadline }) => {
      if (options.cancelThrows) throw new Error(options.cancelThrows)
      return new Promise<AdapterCancelOutcome>((resolve) => {
        cancels.push({ binding: session.binding, turnId: turn.turnId, signal: deadline.signal, settle: resolve })
      })
    },
  })
  const host = createHostFixture({
    ...(options.store ? { store: options.store } : {}),
    transports: { pi: transport },
    recovery: { budgets: BUDGETS, ...(options.now ? { now: options.now } : {}) },
  })
  return { runtime: host.runtime, store: host.store, turns, cancels, transport, dispose: host.dispose }
}

async function openSession(runtime: ReturnType<typeof fixture>["runtime"], id: string) {
  const created = await runtime.sessions.create(sessionCreate({ id }))
  return created.id
}

const origin = LOOPBACK_ORIGIN

function owner(options: { store?: RuntimeStore } = {}) {
  const store = options.store ?? openStore(RuntimeStore)
  store.bindSession({ owner: { kind: "machine-owner" }, sessionId: "ses", directory: "/repo", workspaceId: "ws", connectionId: "native:pi", upstreamSessionId: "ses", agentSessionId: "ses" })
  const admissions = createTurnAdmissions(store)
  const published: string[] = []
  const recovery = createRuntimeRecovery({
    store,
    admissions,
    producer: () => undefined,
    providerTurn: () => undefined,
    cancelTarget: () => Promise.reject(new Error("no harness in this test")),
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
    const { runtime, store, turns, cancels, dispose } = fixture()
    const sessionId = await openSession(runtime, "ses_race")
    const first = await runtime.turns.start({ sessionId, messageId: "msg_a", text: "first", origin })

    const cancelling = runtime.recovery.submit(cancelTurnRequest(first.target!), RECOVERY_TEST_CALLER)
    await until(() => cancels.length === 1, "the harness to be asked to cancel A")
    const attempt = submittedOperation(await cancelling)
    expect(attempt.state).toBe("needs_action")

    // A ends on its own while its cancellation is still outstanding, and the
    // session is handed to a replacement turn with its own durable lease.
    turns[0].finish()
    await until(() => store.getSession(sessionId)?.status !== "busy", "A to finish")
    const second = await runtime.turns.start({ sessionId, messageId: "msg_b", text: "second", origin })
    const replacementLease = second.target!.ownerGeneration
    expect(replacementLease).not.toBe(first.target!.ownerGeneration)

    cancels[0].settle({ execution: "terminal", cleanup: "verified_clear" })
    await tick()

    expect(runtime.recovery.inspect(sessionId).target).toMatchObject({ turnId: "msg_b", ownerGeneration: replacementLease })
    expect(store.getSession(sessionId)?.status).toBe("busy")
    expect(store.acquireTurnLease(sessionId)).toBeUndefined()
    await expect(runtime.turns.start({ sessionId, messageId: "msg_c", text: "third", origin })).rejects.toThrow("already processing")

    const read = runtime.recovery.read(attempt.operationId, RECOVERY_TEST_CALLER)
    expect(read).toMatchObject({ kind: "operation", operation: { state: "needs_action" } })
    expect((read as { operation: RecoveryOperation }).operation.facts.execution.value).toBe("terminal")

    turns[1].finish()
    await dispose()
  })

  test("a harness that ends the turn's stream before answering the cancellation reports the turn saved", async () => {
    const { runtime, store, turns, cancels, dispose } = fixture()
    const sessionId = await openSession(runtime, "ses_stream_first")
    const started = await runtime.turns.start({ sessionId, messageId: "msg_a", text: "first", origin })

    const cancelling = runtime.recovery.submit(cancelTurnRequest(started.target!), RECOVERY_TEST_CALLER)
    await until(() => cancels.length === 1, "the harness to be asked to cancel")
    turns[0].finish()
    await until(() => store.getSession(sessionId)?.status !== "busy", "the producer to finalize the turn")
    cancels[0].settle({ execution: "terminal", cleanup: "unknown" })

    const operation = submittedOperation(await cancelling)
    expect(operation.facts.execution.value).toBe("terminal")
    expect(operation.facts.persistence.value).toBe("committed")
    expect(operation.nextActions.map((next) => next.action)).not.toContain("reconcile_session")
    expect(runtime.recovery.inspect(sessionId).facts.persistence.value).toBe("committed")
    await dispose()
  })

  test("a cancellation naming the turn a lease loss was observed for is refused once that turn ended", async () => {
    const { runtime, store, turns, cancels, dispose } = fixture()
    const sessionId = await openSession(runtime, "ses_stale")
    const first = await runtime.turns.start({ sessionId, messageId: "msg_a", text: "first", origin })
    const observed = first.target!

    turns[0].finish()
    await until(() => store.getSession(sessionId)?.status !== "busy", "A to finish")
    const second = await runtime.turns.start({ sessionId, messageId: "msg_b", text: "second", origin })

    const outcome = await runtime.recovery.submit(cancelTurnRequest(observed), RECOVERY_TEST_CALLER)

    expect(outcome).toMatchObject({
      kind: "refused",
      refusal: { kind: "generation_conflict", current: { turnId: "msg_b", ownerGeneration: second.target!.ownerGeneration } },
    })
    expect(cancels).toHaveLength(0)
    expect(store.getSession(sessionId)?.status).toBe("busy")
    turns[1].finish()
    await dispose()
  })

  test("a harness that never answers yields a bounded operation whose error is inspectable", async () => {
    const { runtime, turns, cancels, dispose } = fixture()
    const sessionId = await openSession(runtime, "ses_wedged")
    const started = await runtime.turns.start({ sessionId, messageId: "msg_a", text: "first", origin })

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
    await dispose()
  })

  test("evidence arriving after the deadline corrects the facts without rewriting the attempt", async () => {
    const { runtime, turns, cancels, dispose } = fixture()
    const sessionId = await openSession(runtime, "ses_late")
    const started = await runtime.turns.start({ sessionId, messageId: "msg_a", text: "first", origin })

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
    await dispose()
  })
})

describe("a finalization the store refused", () => {
  test("keeps the turn's lease until reconcile finishes it, and the session is admissible again after", async () => {
    const store = openStore(BreakableStore)
    const { runtime, turns, dispose } = fixture({ store })
    const sessionId = await openSession(runtime, "ses_refused_finish")
    const started = await runtime.turns.start({ sessionId, messageId: "msg_refused", text: "first", origin })
    const leaseId = store.readTurnAuthority(sessionId)?.leaseId
    store.broken = true
    turns[0].finish()
    await until(() => runtime.recovery.inspect(sessionId).failures.length > 0, "the refusal to reach the owner")
    store.broken = false
    expect(store.readTurnAuthority(sessionId)?.leaseId).toBe(leaseId)
    expect(store.acquireTurnLease(sessionId)).toBeUndefined()
    expect(runtime.recovery.inspect(sessionId).health).toMatchObject({ status: "degraded", reason: "persistence_unavailable" })
    const reconciled = submittedOperation(await runtime.recovery.submit({
      requestId: "req_reconcile_refused", action: "reconcile_session", target: started.target!, scopeRevision: "1", attempt: 1,
    }, RECOVERY_TEST_CALLER))
    expect(reconciled.state).toBe("succeeded")
    expect(store.readTurnAuthority(sessionId)).toBeUndefined()
    expect((await runtime.turns.start({ sessionId, messageId: "msg_next", text: "next", origin })).delivery).toBe("start")
    turns[1].finish()
    await dispose()
  })

  test("a reconciliation that names a different generation is refused", async () => {
    const store = openStore(BreakableStore)
    const { runtime, turns, dispose } = fixture({ store })
    const sessionId = await openSession(runtime, "ses_other_generation")
    const started = await runtime.turns.start({ sessionId, messageId: "msg_a", text: "first", origin })

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
    await dispose()
  })
})

describe("finalizing a turn this owner did not admit", () => {
  test("a capture with no generation cannot end a turn the runtime has since admitted", () => {
    const store = openStore(RuntimeStore)
    store.bindSession({ owner: { kind: "machine-owner" }, sessionId: "ses", directory: "/repo", workspaceId: "ws", connectionId: "native:pi", upstreamSessionId: "ses", agentSessionId: "ses" })
    const admissions = createTurnAdmissions(store)
    const published: string[] = []
    const recovery = createRuntimeRecovery({
      store,
      admissions,
      producer: () => undefined,
      providerTurn: () => undefined,
      cancelTarget: () => Promise.reject(new Error("no harness in this test")),
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
    const { runtime, store, turns, dispose } = fixture()
    const sessionId = await openSession(runtime, "ses_closing")
    await runtime.turns.start({ sessionId, messageId: "msg_a", text: "first", origin })

    const disposal = runtime.dispose()
    await tick()

    const inspection = runtime.recovery.inspect(sessionId)
    expect(inspection.target).toMatchObject({ turnId: "msg_a" })
    expect(inspection.facts.execution.value).toBe("running")
    expect(store.getSession(sessionId)?.status).toBe("busy")

    turns[0].finish()
    await disposal
    expect(runtime.recovery.inspect(sessionId).facts.execution.value).toBe("terminal")
    await dispose()
  })
})

describe("one operation per intent", () => {
  const request = (requestId: string, target: RecoveryOperation["target"], overrides = {}) => ({
    requestId, action: "cancel_turn" as const, target, scopeRevision: "1", attempt: 1, ...overrides,
  })

  test("the same request id twice reads one operation, and a different intent under it conflicts", async () => {
    const { runtime, turns, dispose } = fixture()
    const sessionId = await openSession(runtime, "ses_receipts")
    const started = await runtime.turns.start({ sessionId, messageId: "msg_a", text: "first", origin })

    const first = submittedOperation(await runtime.recovery.submit(request("req_1", started.target!), RECOVERY_TEST_CALLER))
    const repeat = submittedOperation(await runtime.recovery.submit(request("req_1", started.target!), RECOVERY_TEST_CALLER))
    expect(repeat.operationId).toBe(first.operationId)

    const conflict = await runtime.recovery.submit(
      request("req_1", started.target!, { scopeRevision: "2" }),
      RECOVERY_TEST_CALLER,
    )
    expect(conflict).toMatchObject({ kind: "refused", refusal: { kind: "intent_conflict", requestId: "req_1" } })

    turns[0].finish()
    await dispose()
  })

  test("two callers asking for the same action on the same turn share one operation", async () => {
    const { runtime, turns, cancels, dispose } = fixture()
    const sessionId = await openSession(runtime, "ses_coalesce")
    const started = await runtime.turns.start({ sessionId, messageId: "msg_a", text: "first", origin })

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
    await dispose()
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

  test("a failed teardown is not kept: the next dispose stops again, and cleanup runs once", async () => {
    const reported: unknown[] = []
    const lifecycle = createRuntimeLifecycle({ onTeardownFailure: (error) => reported.push(error) })
    let stops = 0
    let cleanups = 0
    const stop = async () => { if (++stops === 1) throw new Error("the harness would not stop") }

    expect(await lifecycle.dispose(stop, () => { cleanups++ })).toMatchObject({ ok: false })
    expect(await lifecycle.dispose(stop, () => { cleanups++ })).toEqual({ ok: true })
    await tick()

    expect(stops).toBe(2)
    expect(cleanups).toBe(1)
    expect(await lifecycle.dispose(stop, () => { cleanups++ })).toEqual({ ok: true })
    expect(stops).toBe(2)
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

    expect(store.getSession("ses")).toMatchObject({ status: "idle", lastTurn: { status: "cancelled", reason: "abort" } })
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
    const { runtime, store, turns, dispose } = fixture()
    return {
      runtime, store, turns, dispose,
      admission: { valid: () => valid, fencingToken: () => 1, proof: () => "turn-lease" },
      revoke: () => { valid = false },
    }
  }

  test("is terminal for this owner: the admission is given up and no retry is advertised", async () => {
    const f = fenced()
    const sessionId = await openSession(f.runtime, "ses_revoked")
    const started = await f.runtime.turns.start({ sessionId, messageId: "msg_a", text: "first", origin, admission: f.admission })

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
    await f.dispose()
  })
})

describe("an operation that throws", () => {
  test("answers its caller, closes, and does not capture the next request for that turn", async () => {
    const { runtime, turns, dispose } = fixture({ cancelThrows: "the harness blew up on the way in" })
    const sessionId = await openSession(runtime, "ses_throwing")
    const started = await runtime.turns.start({ sessionId, messageId: "msg_a", text: "first", origin })

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
    await dispose()
  })
})

describe("receipts the store already holds", () => {
  class AdoptingStore extends RuntimeStore {
    existing?: RecoveryOperation
    override recordRecoveryOperation(operation: RecoveryOperation, caller: { callerId: string }) {
      if (this.existing) return { created: false as const, existing: this.existing }
      return super.recordRecoveryOperation(operation, caller)
    }
  }

  test("an operation another owner already accepted is adopted instead of run again", async () => {
    const store = openStore(AdoptingStore)
    const { runtime, turns, cancels, dispose } = fixture({ store })
    const sessionId = await openSession(runtime, "ses_adopt")
    const started = await runtime.turns.start({ sessionId, messageId: "msg_a", text: "first", origin })
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
    await dispose()
  })

  test("a stored receipt under the same request id but a different intent conflicts", async () => {
    const store = openStore(AdoptingStore)
    const { runtime, turns, dispose } = fixture({ store })
    const sessionId = await openSession(runtime, "ses_adopt_conflict")
    const started = await runtime.turns.start({ sessionId, messageId: "msg_a", text: "first", origin })
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
    await dispose()
  })
})

describe("who may read and act", () => {
  test("an operation is only readable by a caller it was accepted for", async () => {
    const { runtime, turns, dispose } = fixture()
    const sessionId = await openSession(runtime, "ses_reads")
    const started = await runtime.turns.start({ sessionId, messageId: "msg_a", text: "first", origin })
    const operation = submittedOperation(await runtime.recovery.submit(cancelTurnRequest(started.target!), RECOVERY_TEST_CALLER))

    expect(runtime.recovery.read(operation.operationId, { callerId: "someone-else", authority: "session" }))
      .toMatchObject({ kind: "refused", refusal: { kind: "unauthorized" } })
    // An operation this owner never recorded cannot be authorized at all, so it
    // is not answered rather than handed over.
    expect(runtime.recovery.read("rop_never_seen", RECOVERY_TEST_CALLER)).toBeUndefined()

    turns[0].finish()
    await dispose()
  })

  test("a session-scoped caller cannot act on a machine", async () => {
    const { runtime, dispose } = fixture()
    await openSession(runtime, "ses_scope")

    const outcome = await runtime.recovery.submit({
      requestId: "req_drain", action: "drain_daemon", scopeRevision: "1", attempt: 1,
      target: { scope: "machine", machineId: "this-one", ownerGeneration: "gen" },
    }, RECOVERY_TEST_CALLER)

    expect(outcome).toMatchObject({ kind: "refused", refusal: { kind: "unauthorized" } })
    await dispose()
  })
})

describe("what a session's inspection lists", () => {
  class ListingStore extends RuntimeStore {
    stored: RecoveryOperation[] = []
    throws = false
    override listRecoveryOperations(scope: { sessionId?: string } = {}) {
      if (this.throws) throw new Error("the operations table is unreadable")
      return [...super.listRecoveryOperations(scope), ...this.stored]
    }
  }

  test("operations this owner never recorded, and a store that cannot answer", async () => {
    const store = openStore(ListingStore)
    const { runtime, turns, dispose } = fixture({ store })
    const sessionId = await openSession(runtime, "ses_listing")
    const started = await runtime.turns.start({ sessionId, messageId: "msg_a", text: "first", origin })
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
    await dispose()
  })
})

describe("a Goal mutation that outlives the turn it stops", () => {
  function goalController(stop: () => Promise<void>, resolveHarness: () => Promise<void> = () => Promise.resolve()) {
    const held = owner()
    const goals = {
      read: async () => null,
      start: async () => ({ ok: true as const, goal: null }),
      pause: async () => ({ ok: true as const, goal: null }),
      resume: async () => ({ ok: true as const, goal: null }),
      delete: async () => ({ ok: true as const, goal: null }),
      stop: async () => { await stop(); return { ok: true as const, goal: null } },
    }
    const transport = new FakeTransport({
      kind: "pi-rpc",
      capabilities: { goals: { implemented: true, available: true, actions: [], recovery: "blocked", optionalFields: [] } },
      goals,
    })
    const binding = { sessionId: "ses", workspaceId: "ws", directory: "/repo", connectionId: "native:pi", upstreamSessionId: "ses" }
    const attached: AttachedSession = {
      handle: transportHandle({ id: "pi", access: "native" }, transport),
      session: { binding, directory: "/repo", locality: "local" },
      broker: {} as SessionBroker,
      context: { sessionId: "ses", directory: "/repo", workspaceId: "ws", origin },
      owner: MACHINE_OWNER,
    }
    const controller = createRuntimeGoalController({
      store: held.store,
      attached: async () => {
        await resolveHarness()
        return attached
      },
      unattached: async () => ({ handle: attached.handle, directory: "/repo", attached }),
      publish: () => {},
      subscribeRuntime: () => () => {},
      captureTurn: held.recovery.captureSessionTurn,
      cancelCapturedTurn: (capture, directory) => { held.recovery.cancelActiveTurn(capture, directory) },
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
    const { runtime, turns, cancels, dispose } = fixture()
    const sessionId = await openSession(runtime, "ses_authority")
    const started = await runtime.turns.start({ sessionId, messageId: "msg_a", text: "first", origin })

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
    await dispose()
  })
})

describe("an operation that outlives the owner that issued it", () => {
  test("is read back by the callers holding its receipt, and by nobody else", async () => {
    const store = openStore(RuntimeStore)
    const issued = fixture({ store })
    const sessionId = await openSession(issued.runtime, "ses_restart")
    const started = await issued.runtime.turns.start({ sessionId, messageId: "msg_a", text: "first", origin })
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
    await issued.dispose()

    // A fresh owner over the same store: its in-memory registry is empty, so
    // every answer below comes from the receipts the store kept.
    const restarted = fixture({ store })

    expect(restarted.runtime.recovery.read(operation.operationId, RECOVERY_TEST_CALLER))
      .toMatchObject({ kind: "operation", operation: { operationId: operation.operationId } })
    expect(restarted.runtime.recovery.read(operation.operationId, joined))
      .toMatchObject({ kind: "operation", operation: { operationId: operation.operationId } })
    expect(restarted.runtime.recovery.read(operation.operationId, { callerId: "never-asked", authority: "session" }))
      .toBeUndefined()

    await restarted.dispose()
  })

  test("an unreadable store answers nothing and reports why, rather than throwing", async () => {
    class UnreadableStore extends RuntimeStore {
      override readRecoveryOperation(): RecoveryOperation | undefined {
        throw new Error("the operations table is unreadable")
      }
    }
    const { runtime, dispose } = fixture({ store: openStore(UnreadableStore) })
    const sessionId = await openSession(runtime, "ses_unreadable")

    expect(runtime.recovery.read("rop_from_before", RECOVERY_TEST_CALLER)).toBeUndefined()
    expect(runtime.recovery.inspect(sessionId).failures)
      .toContainEqual(expect.objectContaining({ code: "persistence_unavailable" }))

    await dispose()
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

describe("a containment attempt that never became an operation", () => {
  test("is retained against the session, and finishing that turn does not clear it", async () => {
    const { runtime, turns, cancels, dispose } = fixture()
    const sessionId = await openSession(runtime, "ses_containment")
    const started = await runtime.turns.start({ sessionId, messageId: "msg_a", text: "first", origin })

    runtime.recovery.reportContainmentFailure(started.target!, RECOVERY_TEST_CALLER, "the lease owner could not submit")

    const reported = runtime.recovery.inspect(sessionId).failures
    expect(reported).toContainEqual(expect.objectContaining({
      code: "owner_unavailable",
      stage: "graceful_cancel",
      executionMayContinue: true,
      message: expect.stringContaining("the lease owner could not submit"),
    }))

    // The turn is cancelled and finalized cleanly. That records what this owner
    // knows about the turn; it establishes nothing about the execution whose
    // lease was lost, so the obligation stays.
    const cancelling = runtime.recovery.submit(cancelTurnRequest(started.target!), RECOVERY_TEST_CALLER)
    await until(() => cancels.length === 1, "the harness to be asked to cancel")
    cancels[0].settle({ execution: "terminal", cleanup: "unknown" })
    expect(submittedOperation(await cancelling).facts.persistence.value).toBe("committed")

    expect(runtime.recovery.inspect(sessionId).failures).toEqual(reported)
    turns[0].finish()
    await dispose()
  })

  test("a caller that could not act on the target reports nothing", async () => {
    const { runtime, turns, dispose } = fixture()
    const sessionId = await openSession(runtime, "ses_containment_scope")
    const started = await runtime.turns.start({ sessionId, messageId: "msg_a", text: "first", origin })

    runtime.recovery.reportContainmentFailure(started.target!, RECOVERY_TEST_CALLER, "recorded")
    runtime.recovery.reportContainmentFailure(
      { ...started.target!, sessionId: "another-session" },
      RECOVERY_TEST_CALLER,
      "belongs to a session this inspection does not cover",
    )

    expect(runtime.recovery.inspect(sessionId).failures).toHaveLength(1)
    expect(runtime.recovery.inspect("another-session").failures).toHaveLength(1)
    turns[0].finish()
    await dispose()
  })
})

describe("how long a settled operation stays readable", () => {
  test("for the contract's retention, not for whatever this caller's deadlines were", async () => {
    let clock = 1_000_000
    const { runtime, turns, cancels, dispose } = fixture({ now: () => clock })
    const sessionId = await openSession(runtime, "ses_retention")
    const started = await runtime.turns.start({ sessionId, messageId: "msg_a", text: "first", origin })
    const operation = submittedOperation(await runtime.recovery.submit(cancelTurnRequest(started.target!), RECOVERY_TEST_CALLER))

    // Well past every budget this runtime was given, and past ten times the
    // reconcile one. Retention is not derived from them.
    clock += BUDGETS.reconcileMs * 100
    expect(runtime.recovery.read(operation.operationId, RECOVERY_TEST_CALLER))
      .toMatchObject({ kind: "operation", operation: { operationId: operation.operationId } })

    clock += RECOVERY_OPERATION_RETENTION_MS
    expect(runtime.recovery.read(operation.operationId, RECOVERY_TEST_CALLER))
      .toMatchObject({ kind: "refused", refusal: { kind: "receipt_expired" } })

    turns[0].finish()
    cancels[0]?.settle({ execution: "unknown", cleanup: "unknown" })
    await dispose()
  })
})

describe("cancellation outcomes", () => {
  const budgets = { ackMs: 5_000, providerQueryMs: 5_000, gracefulCancelMs: 200, reconcileMs: 5_000 }

  async function fixture(cancel: () => Promise<AdapterCancelOutcome>) {
    const control = controlledTurn("s")
    const transport = new FakeTransport({ turn: () => control.events, cancel })
    const f = createHostFixture({ transports: { pi: transport }, recovery: { budgets } })
    await f.runtime.sessions.create(sessionCreate({ id: "s" }))
    const started = await f.runtime.turns.start({ sessionId: "s", text: "work", origin: LOOPBACK_ORIGIN })
    return { ...f, control, transport, started, cancel: () => f.runtime.recovery.submit(cancelTurnRequest(started.target!), RECOVERY_TEST_CALLER) }
  }

  test.each(["error", "not_found"] as const)("failed cancellation %s keeps admission until the executing producer ends", async (kind) => {
    const f = await fixture(async () => kind === "error"
      ? { execution: "running", cleanup: "unknown", error: { code: "provider_unreachable", message: "refused" } }
      : { execution: "unknown", cleanup: "unknown", error: { code: "provider_unreachable", message: "not found" } })
    try {
      const result = submittedOperation(await f.cancel())
      expect(result.facts.execution.value).not.toBe("terminal")
      expect(f.store.getSession("s")?.status).toBe("busy")
      await expect(f.runtime.turns.start({ sessionId: "s", text: "replacement", origin: LOOPBACK_ORIGIN })).rejects.toThrow()
      expect(f.transport.turns).toHaveLength(1)
      f.control.finish()
      const idle = await f.runtime.turns.whenIdle("s")
      idle.abandon()
      expect((await f.runtime.turns.start({ sessionId: "s", text: "next", origin: LOOPBACK_ORIGIN })).delivery).toBe("start")
    } finally { f.control.finish(); await f.dispose() }
  })

  test("a cancellation rejection reports provider_unreachable while preserving the open producer", async () => {
    const f = await fixture(async () => { throw new Error("provider refused the cancel") })
    try {
      const result = submittedOperation(await f.cancel())
      expect(result.facts.execution.value).toBe("running")
      expect(result.initiatingError).toMatchObject({ code: "provider_unreachable", executionMayContinue: true })
      expect(result.initiatingError?.message).toContain("provider refused the cancel")
      expect(f.store.getSession("s")?.status).toBe("busy")
    } finally { f.control.finish(); await f.dispose() }
  })

  test("a transient cancellation failure does not poison a subsequent stop", async () => {
    let attempts = 0
    const f = await fixture(async () => {
      if (++attempts === 1) throw new Error("try again")
      return { execution: "terminal", cleanup: "verified_clear" }
    })
    try {
      expect(submittedOperation(await f.cancel()).initiatingError?.code).toBe("provider_unreachable")
      expect(submittedOperation(await f.cancel()).facts.execution.value).toBe("terminal")
      expect(attempts).toBe(2)
      expect(f.store.getSession("s")?.status).toBe("idle")
    } finally { f.control.finish(); await f.dispose() }
  })

  test("late stream completion preserves the already committed cancelled outcome", async () => {
    const f = await fixture(async () => ({ execution: "terminal", cleanup: "verified_clear" }))
    try {
      await f.cancel()
      expect(f.store.getSession("s")?.lastTurn?.status).toBe("cancelled")
      const outcome = f.store.getSession("s")?.lastTurn
      f.control.finish()
      await f.runtime.dispose()
      expect(f.store.getSession("s")?.lastTurn).toEqual(outcome)
    } finally { f.control.finish(); await f.dispose() }
  })

  test("a stop acknowledgement leaves admission available to an immediate replacement", async () => {
    const f = await fixture(async () => ({ execution: "terminal", cleanup: "verified_clear" }))
    try {
      await f.cancel()
      f.control.finish()
      expect((await f.runtime.turns.start({ sessionId: "s", text: "replacement", origin: LOOPBACK_ORIGIN })).delivery).toBe("start")
      await tick()
    } finally { f.control.finish(); await f.dispose() }
  })

  const refusedThenThrows = (after?: () => AdapterCancelOutcome) => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let attempts = 0
    const transport = new FakeTransport({
      turn: async function* () { await gate; throw new Error("ACP cancel failed; prompt outcome is uncertain") },
      cancel: async () => {
        if (++attempts > 1 && after) return after()
        release()
        await tick()
        throw new Error("provider refused the abort")
      },
    })
    return { transport, release: () => release() }
  }

  async function heldTurn(f: HostFixture) {
    await f.runtime.sessions.create(sessionCreate({ id: "s" }))
    const started = await f.runtime.turns.start({ sessionId: "s", text: "work", origin: LOOPBACK_ORIGIN })
    const refused = submittedOperation(await f.runtime.recovery.submit(cancelTurnRequest(started.target!), RECOVERY_TEST_CALLER))
    return { started, refused }
  }

  test("a producer that throws while its stop is unconfirmed is held degraded until reconcile ends it", async () => {
    const { transport, release } = refusedThenThrows(() => ({ execution: "unknown", cleanup: "unknown" }))
    const f = createHostFixture({ transports: { pi: transport }, recovery: { budgets } })
    try {
      const { started, refused } = await heldTurn(f)
      expect(refused.initiatingError).toMatchObject({ code: "provider_unreachable" })
      expect(refused.facts.execution.value).toBe("unknown")
      expect(f.store.getSession("s")?.status).toBe("busy")
      expect(f.store.getSession("s")?.lastTurn).toBeUndefined()
      expect(f.runtime.recovery.inspect("s").health).toMatchObject({ status: "degraded", reason: "exit_unverified" })
      await expect(f.runtime.turns.start({ sessionId: "s", text: "replacement", origin: LOOPBACK_ORIGIN })).rejects.toThrow()
      const again = submittedOperation(await f.runtime.recovery.submit(cancelTurnRequest(started.target!), RECOVERY_TEST_CALLER))
      expect(again.facts.execution.value).toBe("unknown")
      expect(f.store.getSession("s")?.status).toBe("busy")
      const reconciled = submittedOperation(await f.runtime.recovery.submit({
        ...cancelTurnRequest(started.target!), action: "reconcile_session",
      }, RECOVERY_TEST_CALLER))
      expect(reconciled.state).toBe("succeeded")
      expect(f.store.getSession("s")?.status).toBe("error")
      expect(f.store.getSession("s")?.lastTurn).toMatchObject({ status: "failed", error: "ACP cancel failed; prompt outcome is uncertain" })
      expect(f.runtime.recovery.inspect("s").health.status).toBe("ok")
      expect((await f.runtime.turns.start({ sessionId: "s", text: "next", origin: LOOPBACK_ORIGIN })).delivery).toBe("start")
      expect(transport.turns).toHaveLength(2)
    } finally { release(); await f.dispose() }
  })

  test("a held turn ends as soon as its connection's transport is retired", async () => {
    const { transport, release } = refusedThenThrows()
    const transports = createWorkspaceTransports({
      composer: { connection: () => transport, builtIn: () => transport } as unknown as WorkspaceTransportsInput["composer"],
      connections: () => new Map([["conn", { providerKey: "test", connectionId: "conn", configRevision: 1, enabled: true, config: {} } as unknown as RuntimeConnectionDescriptor]]),
      resolveSecrets: () => ({ secrets: {}, secretLeaseGeneration: "none" }),
    })
    const f = createHostFixture({ transports, recovery: { budgets } })
    try {
      await f.runtime.sessions.create(sessionCreate({ id: "s", harness: { id: "conn", access: "connection" } }))
      const started = await f.runtime.turns.start({ sessionId: "s", text: "work", origin: LOOPBACK_ORIGIN })
      await f.runtime.recovery.submit(cancelTurnRequest(started.target!), RECOVERY_TEST_CALLER)
      expect(f.store.getSession("s")?.status).toBe("busy")
      transports.retireConnection("conn")
      expect(f.store.getSession("s")?.status).toBe("error")
      expect(f.store.getSession("s")?.lastTurn?.status).toBe("failed")
      expect(f.runtime.recovery.inspect("s").failures.some((failure) => failure.code === "exit_unverified")).toBe(false)
    } finally { release(); await f.dispose(); await transports.disposeAll() }
  })

  test("disposal ends a held turn", async () => {
    const { transport, release } = refusedThenThrows()
    const f = createHostFixture({ transports: { pi: transport }, recovery: { budgets } })
    try {
      await heldTurn(f)
      expect(f.store.getSession("s")?.status).toBe("busy")
      await f.runtime.dispose()
      expect(f.store.getSession("s")?.status).toBe("error")
      expect(f.store.getSession("s")?.lastTurn?.status).toBe("failed")
    } finally { release(); await f.dispose() }
  })

  test("a held parent keeps its foreground child until the hold ends", async () => {
    const { transport, release } = refusedThenThrows()
    const f = createHostFixture({ transports: { pi: transport }, recovery: { budgets } })
    try {
      await f.runtime.sessions.create(sessionCreate({ id: "s" }))
      const started = await f.runtime.turns.start({ sessionId: "s", text: "work", origin: LOOPBACK_ORIGIN })
      await until(() => transport.turns.length === 1)
      const child = await transport.turns[0].broker.observeSubagent({
        observationId: "fg", providerId: "fg", providerKind: "test", status: "running", mode: "foreground", transcript: { kind: "messages" },
      })
      const childLease = f.store.readTurnAuthority(child!.sessionId)?.leaseId
      await f.runtime.recovery.submit(cancelTurnRequest(started.target!), RECOVERY_TEST_CALLER)
      expect(f.store.getSession("s")?.status).toBe("busy")
      expect(f.store.getSession(child!.sessionId)?.status).toBe("busy")
      expect(f.store.readTurnAuthority(child!.sessionId)?.leaseId).toBe(childLease)
      await f.runtime.recovery.submit({ ...cancelTurnRequest(started.target!), action: "reconcile_session" }, RECOVERY_TEST_CALLER)
      expect(f.store.getSession("s")?.status).toBe("error")
      expect(f.store.getSession(child!.sessionId)?.status).toBe("idle")
      expect(f.store.readTurnAuthority(child!.sessionId)).toBeUndefined()
    } finally { release(); await f.dispose() }
  })

  test("a held parent whose write authority is lost still ends its foreground child", async () => {
    const { transport, release } = refusedThenThrows()
    const f = createHostFixture({ transports: { pi: transport }, recovery: { budgets } })
    let valid = true
    try {
      await f.runtime.sessions.create(sessionCreate({ id: "s" }))
      const started = await f.runtime.turns.start({ sessionId: "s", text: "work", origin: LOOPBACK_ORIGIN,
        admission: { valid: () => valid, fencingToken: () => 1, proof: () => "turn-lease" } })
      await until(() => transport.turns.length === 1)
      const child = await transport.turns[0].broker.observeSubagent({
        observationId: "fg", providerId: "fg", providerKind: "test", status: "running", mode: "foreground", transcript: { kind: "messages" },
      })
      await f.runtime.recovery.submit(cancelTurnRequest(started.target!), RECOVERY_TEST_CALLER)
      expect(f.store.getSession(child!.sessionId)?.status).toBe("busy")
      valid = false
      await f.runtime.recovery.submit({ ...cancelTurnRequest(started.target!), action: "reconcile_session" }, RECOVERY_TEST_CALLER)
      expect(f.runtime.recovery.inspect("s").failures.map((failure) => failure.code)).toContain("authority_lost")
      expect(f.store.getSession(child!.sessionId)?.status).toBe("idle")
      expect(f.store.readTurnAuthority(child!.sessionId)).toBeUndefined()
    } finally { release(); await f.dispose() }
  })

  test("a producer that ends cleanly after its provider refuses cancellation is cancelled by that one stop", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const transport = new FakeTransport({ turn: async function* () { await gate }, cancel: async () => {
      release()
      await tick()
      throw new Error("provider refused the abort")
    } })
    const f = createHostFixture({ transports: { pi: transport }, recovery: { budgets } })
    try {
      const { refused } = await heldTurn(f)
      expect(refused.initiatingError).toMatchObject({ code: "provider_unreachable" })
      await until(() => f.store.getSession("s")?.status === "idle")
      expect(f.store.getSession("s")?.lastTurn?.status).toBe("cancelled")
      expect(f.runtime.recovery.inspect("s").health.status).toBe("ok")
    } finally { release(); await f.dispose() }
  })

  test("a stop whose provider ends the turn with its ordinary finish before answering records the turn cancelled", async () => {
    const control = controlledTurn("s")
    const transport = new FakeTransport({ turn: () => control.events, drainsAfterAbort: true, cancel: async () => {
      control.finish()
      await until(() => f.store.getSession("s")?.status === "idle", "the producer to finalize the turn")
      return { execution: "terminal", cleanup: "unknown" }
    } })
    const f = createHostFixture({ transports: { pi: transport }, recovery: { budgets } })
    try {
      const { refused: stopped } = await heldTurn(f)
      expect(stopped.facts.execution.value).toBe("terminal")
      expect(stopped.facts.persistence.value).toBe("committed")
      expect(f.store.getSession("s")?.lastTurn).toMatchObject({ status: "cancelled", reason: "abort" })
      expect(transport.cancels).toHaveLength(1)
    } finally { control.finish(); await f.dispose() }
  })

  test("a Claude-shaped stop that aborts its stream and answers unknown ends the turn cancelled on the first stop", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const transport = new FakeTransport({ turn: async function* () { await gate }, cancel: async () => {
      release()
      await tick()
      return { execution: "unknown", cleanup: "unknown" }
    } })
    const f = createHostFixture({ transports: { pi: transport }, recovery: { budgets } })
    try {
      const { refused: stopped } = await heldTurn(f)
      expect(turnStopped({ kind: "operation", operation: stopped })).toBe(true)
      expect(stopped.facts.execution.value).toBe("terminal")
      expect(stopped.facts.persistence.value).toBe("committed")
      expect(stopped.nextActions?.map((next) => next.action)).not.toContain("reconcile_session")
      expect(f.store.getSession("s")?.status).toBe("idle")
      expect(f.store.getSession("s")?.lastTurn?.status).toBe("cancelled")
      expect(transport.cancels).toHaveLength(1)
      expect((await f.runtime.turns.start({ sessionId: "s", text: "next", origin: LOOPBACK_ORIGIN })).delivery).toBe("start")
    } finally { release(); await f.dispose() }
  })
})

describe("what makes a stop unconfirmed", () => {
  const throwing = () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    return { gate, release: () => release() }
  }

  test("a stop that never reached the transport leaves a later producer failure to finalize as failed", async () => {
    const { gate, release } = throwing()
    const transport = new FakeTransport({ turn: async function* () { await gate; throw new Error("provider died") } })
    const f = createHostFixture({ transports: { pi: transport }, recovery: { budgets: { ackMs: 5_000, providerQueryMs: 0, gracefulCancelMs: 5_000, reconcileMs: 5_000 } } })
    try {
      await f.runtime.sessions.create(sessionCreate({ id: "s" }))
      const started = await f.runtime.turns.start({ sessionId: "s", text: "work", origin: LOOPBACK_ORIGIN })
      const unresolved = submittedOperation(await f.runtime.recovery.submit(cancelTurnRequest(started.target!), RECOVERY_TEST_CALLER))
      expect(unresolved.phase).toBe("provider_query")
      expect(transport.cancels).toHaveLength(0)
      release()
      await until(() => f.store.getSession("s")?.status !== "busy")
      expect(f.store.getSession("s")?.lastTurn).toMatchObject({ status: "failed", error: "provider died" })
      expect(f.runtime.recovery.inspect("s").failures.map((failure) => failure.code)).not.toContain("exit_unverified")
    } finally { release(); await f.dispose() }
  })

  test("a stop the transport confirmed is not held when the producer then fails", async () => {
    const { gate, release } = throwing()
    const store = openStore(BreakableStore)
    const transport = new FakeTransport({
      turn: async function* () { await gate; throw new Error("provider died after the stop") },
      cancel: async () => { store.broken = true; return { execution: "terminal", cleanup: "verified_clear" } },
    })
    let clock = Date.now()
    const f = createHostFixture({ store, transports: { pi: transport },
      recovery: { budgets: { ackMs: 5_000, providerQueryMs: 5_000, gracefulCancelMs: 200, reconcileMs: 5_000 }, now: () => clock } })
    try {
      await f.runtime.sessions.create(sessionCreate({ id: "s" }))
      const started = await f.runtime.turns.start({ sessionId: "s", text: "work", origin: LOOPBACK_ORIGIN })
      await f.runtime.recovery.submit(cancelTurnRequest(started.target!), RECOVERY_TEST_CALLER)
      expect(f.runtime.recovery.inspect("s").failures.map((failure) => failure.code)).toEqual(["persistence_unavailable"])
      const refusedAt = f.runtime.recovery.inspect("s").failures[0].at
      clock += 1
      release()
      await until(() => f.runtime.recovery.inspect("s").failures[0].at !== refusedAt, "the producer's own failure to be retained")
      const codes = f.runtime.recovery.inspect("s").failures.map((failure) => failure.code)
      expect(codes).toContain("persistence_unavailable")
      expect(codes).not.toContain("exit_unverified")
    } finally { store.broken = false; release(); await f.runtime.dispose() }
  })
})

describe("a stop sent while the transport is still starting the turn", () => {
  test.each([
    ["unknown, as Codex and Pi answer before submission", { execution: "unknown", cleanup: "unknown" }],
    ["terminal, as Claude and Cursor answer before submission", { execution: "terminal", cleanup: "unknown" }],
  ] as const)("reaches the transport's pre-submission check when the cancel answers %s", async (_shape, answer) => {
    let ready!: () => void
    const starting = new Promise<void>((resolve) => { ready = resolve })
    let submitted = 0
    const transport = new FakeTransport({
      turn: async function* ({ broker, session }) {
        await starting
        if (broker.signal.aborted) return
        submitted++
        yield { type: "finish", sessionId: session.binding.sessionId }
      },
      cancel: async () => { ready(); await tick(); return answer },
    })
    const f = createHostFixture({ transports: { pi: transport }, recovery: { budgets: { ackMs: 5_000, providerQueryMs: 5_000, gracefulCancelMs: 5_000, reconcileMs: 5_000 } } })
    try {
      await f.runtime.sessions.create(sessionCreate({ id: "s" }))
      const started = await f.runtime.turns.start({ sessionId: "s", text: "work", origin: LOOPBACK_ORIGIN })
      await f.runtime.recovery.submit(cancelTurnRequest(started.target!), RECOVERY_TEST_CALLER)
      expect(submitted).toBe(0)
      expect(transport.cancels).toHaveLength(1)
      expect(f.store.getSession("s")?.lastTurn?.status).toBe("cancelled")
      expect((await f.runtime.turns.start({ sessionId: "s", text: "next", origin: LOOPBACK_ORIGIN })).delivery).toBe("start")
    } finally { ready(); await f.dispose() }
  })
})

describe("a stop the transport confirms while output is still queued", () => {
  test("the producer drains that output before the turn is finalized", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const transport = new FakeTransport({
      turn: async function* () {
        await gate
        for (let chunk = 0; chunk < 3; chunk++) {
          await tick()
          yield { type: "text-delta", delta: `chunk${chunk} ` }
        }
        yield { type: "finish", sessionId: "s" }
      },
      cancel: async () => { release(); return { execution: "terminal", cleanup: "verified_clear" } },
      drainsAfterAbort: true,
    })
    const f = createHostFixture({ transports: { pi: transport }, recovery: { budgets: { ackMs: 5_000, providerQueryMs: 5_000, gracefulCancelMs: 5_000, reconcileMs: 5_000 } } })
    try {
      await f.runtime.sessions.create(sessionCreate({ id: "s" }))
      const started = await f.runtime.turns.start({ sessionId: "s", text: "work", origin: LOOPBACK_ORIGIN })
      const stopped = submittedOperation(await f.runtime.recovery.submit(cancelTurnRequest(started.target!), RECOVERY_TEST_CALLER))
      expect(stopped.facts.persistence.value).toBe("committed")
      const assistant = f.store.getMessages("s").find((message) => message.info.role === "assistant")
      expect(JSON.stringify(assistant?.parts)).toContain("chunk0 chunk1 chunk2 ")
    } finally { release(); await f.dispose() }
  })
})

describe("a provider turn the store refused to finish", () => {
  test("keeps its lease and a degraded session until reconcile finishes it", async () => {
    const brokers = new Map<string, SessionBroker>()
    const transport = new FakeTransport({ beforeStart: async (input, broker) => { brokers.set(input.sessionId, broker) } })
    const f = createHostFixture({ transports: { pi: transport } })
    const finish = f.store.finishTurn.bind(f.store)
    try {
      await f.runtime.sessions.create({ ...sessionCreate({ id: "s" }), agent: "build", model: { providerID: "test", modelID: "test" } })
      f.store.finishTurn = () => { throw new Error("finish write refused") }
      const admitted = await brokers.get("s")!.admitProviderTurn({ reason: "goal" }, async function* () { yield { event: { type: "finish", sessionId: "s" } } })
      if (!admitted.admitted) throw new Error("expected an admitted provider turn")
      expect(await admitted.settled).toEqual({ state: "failed", error: "finish write refused" })
      f.store.finishTurn = finish
      const leaseId = f.store.readTurnAuthority("s")?.leaseId
      expect(leaseId).toBeString()
      expect(f.store.acquireTurnLease("s")).toBeUndefined()
      expect(f.store.turnEvidence("s", admitted.turn.assistantMessageId).finished).toBe(false)
      const inspection = f.runtime.recovery.inspect("s")
      expect(inspection.health).toMatchObject({ status: "degraded", reason: "persistence_unavailable" })
      const retained = inspection.failures.find((failure) => failure.code === "persistence_unavailable")
      expect(retained?.target).toMatchObject({ scope: "session", sessionId: "s", ownerGeneration: leaseId })
      const reconciled = submittedOperation(await f.runtime.recovery.submit({
        requestId: "reconcile-provider-turn", action: "reconcile_session", target: retained!.target, scopeRevision: "1", attempt: 1,
      }, RECOVERY_TEST_CALLER))
      expect(reconciled.state).toBe("succeeded")
      expect(f.store.turnEvidence("s", admitted.turn.assistantMessageId).finished).toBe(true)
      expect(f.store.getSession("s")?.lastTurn?.status).toBe("completed")
      expect(f.store.readTurnAuthority("s")).toBeUndefined()
      expect(f.runtime.recovery.inspect("s").health.status).toBe("ok")
      const next = await brokers.get("s")!.admitProviderTurn({ reason: "goal" }, async function* () { yield { event: { type: "finish", sessionId: "s" } } })
      expect(next.admitted).toBe(true)
      if (next.admitted) expect(await next.settled).toEqual({ state: "completed" })
    } finally { f.store.finishTurn = finish; await f.dispose() }
  })
})
