import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequestBroker, createSessionBroker, createTurnBroker } from "@claxedo/harness/broker"
import { MemoryPorts, registerBrokerBehaviorCases, registerBrokerPortCases, registerChildOwnedRequestCases, registerChildRequestCases } from "@claxedo/harness/testing"
import type { PendingRequest, RoutedEvent } from "@claxedo/harness/contract"
import type { BrokerEvent, TurnAuthority } from "@claxedo/harness/broker"
import type { RuntimeStore } from "../store"
import { openTestRuntimeStore } from "../test-support/store"
import { createRequestSurface } from "../host/requests"
import { createRuntimeEventHub } from "../projection/runtime-event-hub"
import { createStoreBrokerPorts, type StoreBrokerPortOptions } from "./index"
import { harnessAuthor, providerTurnNotice } from "./provider-turn-message"
import { assistantMessageIdForTurn, createMessageIds } from "@claxedo/agent-runtime-contract"

const origin = { actor: { kind: "machine-owner" as const }, via: "loopback" as const, reissued: false }
const question = (id: string) => ({
  kind: "question" as const, requestId: id,
  question: { id, sessionID: "s1", questions: [{ header: "Question", question: "Continue?", options: [], custom: true }] },
})
const permission = (id: string) => ({
  kind: "permission" as const, requestId: id, grantKey: "run",
  permission: { id, sessionID: "s1", permission: "execute", patterns: [], always: [], metadata: {} },
})

const opened: { store: RuntimeStore; root: string }[] = []

function setup(options: Partial<StoreBrokerPortOptions> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "broker-store-"))
  const store = openTestRuntimeStore(root)
  opened.push({ store, root })
  store.bindSession({
    owner: { kind: "machine-owner" },
    sessionId: "s1", workspaceId: "w1", directory: "/work", connectionId: "c1",
    upstreamSessionId: "up1", agentSessionId: "up1", createdAt: 1,
  })
  store.updateSessionConfig("s1", {
    harness: { id: "claude", access: "native" }, agent: "general",
    model: { providerID: "anthropic", modelID: "test" },
  })
  const lease = store.acquireTurnLease("s1")
  if (!lease) throw new Error("Expected turn lease")
  store.startTurn({
    sessionId: "s1", assistantMessageId: "t1", agent: "general",
    model: { providerID: "anthropic", modelID: "test" }, parts: [],
  })
  const publishers = createRuntimeEventHub()
  const ports = createStoreBrokerPorts(store, {
    ownerGeneration: "g1", patternEvaluator: async () => {}, publishers,
    reportOwnerFailure: (_sessionId, error) => { throw error },
    retainLeasedTurnFailure: (_sessionId, _turn, error) => { throw error },
    ...options,
  })
  const authority = ports.currentTurnAuthority("s1")
  if (!authority) throw new Error("Expected turn authority")
  return { root, store, ports, authority, publishers }
}

afterEach(() => {
  for (const entry of opened.splice(0)) {
    entry.store.close()
    fs.rmSync(entry.root, { recursive: true, force: true })
  }
})

const tick = async () => { for (let index = 0; index < 12; index++) await Promise.resolve() }

registerBrokerPortCases("runtime store", () => {
  const { store, ports, authority } = setup()
  return {
    ports, authority,
    prepareProviderTurn: () => {
      const leaseId = store.readTurnAuthority("s1")?.leaseId
      if (!leaseId) throw new Error("Missing initial lease")
      store.finishTurn({ sessionId: "s1", assistantMessageId: "t1", leaseId,
        outcome: { status: "completed", completedAt: 10 } })
      store.releaseTurnLease("s1", leaseId)
    },
    abortProviderTurn: () => ports.abortProviderTurn("s1"),
    close: () => {},
  }
})

class StoreBehaviorPorts extends MemoryPorts {
  private readonly store: RuntimeStore
  private readonly real: ReturnType<typeof createStoreBrokerPorts>

  constructor() {
    super()
    const fixture = setup({ clock: this.clock,
      patternEvaluator: (checks, signal) => this.services.patternEvaluator(checks, signal),
      reportOwnerFailure: (_sessionId, error) => { this.failures.push(error) },
    })
    this.store = fixture.store
    this.real = fixture.ports
    Object.defineProperty(this, "subagentAdmissionStore", { value: this.real.subagentAdmissionStore })
    const currentSet = this.current.set.bind(this.current)
    this.current.set = (sessionId, value) => {
      this.syncAuthority(sessionId, value)
      return currentSet(sessionId, value)
    }
    const currentDelete = this.current.delete.bind(this.current)
    this.current.delete = (sessionId) => {
      this.finishActiveTurn(sessionId)
      return currentDelete(sessionId)
    }
    const stateSet = this.states.set.bind(this.states)
    this.states.set = (sessionId, value) => {
      this.store.updateSessionConfig(sessionId, { permissionState: value })
      return stateSet(sessionId, value)
    }
    const pendingSet = this.pendingRows.set.bind(this.pendingRows)
    this.pendingRows.set = (key, pending) => {
      const event: BrokerEvent = pending.request.kind === "permission"
        ? { id: `permission.asked:${pending.sessionId}:${pending.request.requestId}`,
          type: "permission.asked", properties: pending.request.permission }
        : { id: `question.asked:${pending.sessionId}:${pending.request.requestId}`,
          type: "question.asked", properties: pending.request.kind === "question"
            ? pending.request.question : { id: pending.request.requestId, sessionID: pending.sessionId, questions: [] } }
      void this.real.publish(event, pending)
      return pendingSet(key, pending)
    }
    const answerSet = this.answers.set.bind(this.answers)
    this.answers.set = (key, answer) => {
      const decoded: unknown = JSON.parse(key)
      if (!Array.isArray(decoded) || typeof decoded[0] !== "string" || typeof decoded[1] !== "string") {
        throw new Error("Invalid test answer key")
      }
      const pending: PendingRequest = { sessionId: decoded[0], request: question(decoded[1]),
        askedAt: 1, upstreamSessionId: "up1" }
      void this.real.persistAnswer(pending, answer, false)
      return answerSet(key, answer)
    }
  }

  private finishActiveTurn(sessionId: string): void {
    const active = this.real.currentTurnAuthority(sessionId)
    const leaseId = this.store.readTurnAuthority(sessionId)?.leaseId
    if (!active || !leaseId) return
    this.store.finishTurn({ sessionId, assistantMessageId: active.turnId, leaseId,
      outcome: { status: "completed", completedAt: Date.now() } })
    this.store.releaseTurnLease(sessionId, leaseId)
  }

  private syncAuthority(sessionId: string, desired: TurnAuthority): void {
    const active = this.real.currentTurnAuthority(sessionId)
    if (active && active.turnId !== desired.turnId) this.finishActiveTurn(sessionId)
    this.store.bindSession({ owner: { kind: "machine-owner" }, sessionId, workspaceId: desired.workspaceId, directory: desired.directory,
      connectionId: desired.connectionId, upstreamSessionId: desired.upstreamSessionId,
      agentSessionId: desired.upstreamSessionId })
    this.store.updateSessionConfig(sessionId, { harness: { id: "claude", access: "native" },
      agent: "general", model: { providerID: "anthropic", modelID: "test" } })
    if (this.real.currentTurnAuthority(sessionId)) return
    const lease = this.store.acquireTurnLease(sessionId)
    if (!lease) throw new Error(`No test lease for ${sessionId}`)
    this.store.startTurn({ sessionId, assistantMessageId: desired.turnId, agent: "general",
      model: { providerID: "anthropic", modelID: "test" }, parts: [] })
  }

  override currentTurnAuthority(sessionId: string) { return this.real.currentTurnAuthority(sessionId) }
  override readStart(sessionId: string) {
    if (this.startBinding?.sessionId === sessionId) {
      const existing = this.store.sessionStarts.get(sessionId)
      if (!existing) this.store.sessionStarts.begin(this.startBinding)
      if (this.startStatus === "starting" && existing?.status !== "starting") {
        const record = { binding: this.startBinding, status: "starting", createdAt: 1, updatedAt: 1 }
        this.store.database().prepare("UPDATE session_start SET data_json = ? WHERE session_id = ?")
          .run(JSON.stringify(record), sessionId)
      } else if (this.startStatus !== "starting" && (!existing || existing.status === "starting")) {
        this.store.sessionStarts.finish(this.startBinding, this.startStatus === "created"
          ? { status: "created", upstreamSessionId: "up1" } : { status: "failed", error: "failed" })
      }
    }
    return this.real.readStart(sessionId)
  }
  override readPending(scope: { sessionId: string } | { directory: string }) { return this.real.readPending(scope) }
  override async persistAnswer(...args: Parameters<MemoryPorts["persistAnswer"]>) {
    if (this.failPersist) throw new Error("disk unavailable")
    if (args[3] && this.failGrant) throw new Error("grant write unavailable")
    const before = this.real.readAnswer(args[0].sessionId, args[0].request.requestId)
    const events = await this.real.persistAnswer(...args)
    if (!before) this.saved.push({ pending: args[0], answer: args[1], automatic: args[2] })
    return events
  }
  override readAnswer(sessionId: string, requestId: string) { return this.real.readAnswer(sessionId, requestId) }
  override async publish(...args: Parameters<MemoryPorts["publish"]>) {
    await this.publishGate
    await this.real.publish(...args)
    this.published.push(args[0])
  }
  override readPermissionState(sessionId: string) {
    this.onReadPermissionState?.()
    return this.real.readPermissionState(sessionId)
  }
  override readGoal(sessionId: string) { return this.real.readGoal(sessionId) }
  override publishGoal(sessionId: string, snapshot: Parameters<typeof this.real.publishGoal>[1]) {
    return this.real.publishGoal(sessionId, snapshot)
  }
  override async admitProviderTurn(...args: Parameters<typeof this.real.admitProviderTurn>) {
    this.finishActiveTurn(args[0])
    return this.real.admitProviderTurn(...args)
  }
  override cancelProviderTurn() { this.real.abortProviderTurn("s1") }
  override async drainProviderEvent(...args: Parameters<typeof this.real.drainProviderEvent>) {
    await this.real.drainProviderEvent(...args)
    this.drained.push(args[2])
  }
  override meterUsage(usage: Parameters<typeof this.real.meterUsage>[0]) { this.real.meterUsage(usage) }
  override async publishSessionEvent(...args: Parameters<typeof this.real.publishSessionEvent>) {
    await this.real.publishSessionEvent(...args)
    this.sessionEvents.push({ sessionId: args[0], event: args[1] })
  }
  override async admitChildSession(...args: Parameters<typeof this.real.admitChildSession>) {
    return this.real.admitChildSession(...args)
  }
  override bindChildCorrelation(...args: Parameters<typeof this.real.bindChildCorrelation>) {
    this.real.bindChildCorrelation(...args)
  }
  override childRoute(...args: Parameters<typeof this.real.childRoute>) { return this.real.childRoute(...args) }
  override sessionAuthority(sessionId: string) { return this.real.sessionAuthority(sessionId) }
  override turnOpen(sessionId: string, turnId: string) { return this.real.turnOpen(sessionId, turnId) }
  private readonly childLeases = new Map<string, string>()
  private boundChild(parentSessionId: string, correlationKey: string) {
    const route = this.real.childRoute(parentSessionId, correlationKey)
    if (route.kind !== "bound") throw new Error(`No running child bound to ${correlationKey}`)
    return route
  }
  override startChildTurn(parentSessionId: string, correlationKey: string) {
    const route = this.boundChild(parentSessionId, correlationKey)
    const leaseId = this.store.acquireTurnLease(route.childSessionId)
    if (!leaseId) throw new Error(`No test lease for ${route.childSessionId}`)
    this.store.startTurn({ sessionId: route.childSessionId, assistantMessageId: route.assistantMessageId, agent: "general", parts: [] })
    this.childLeases.set(route.childSessionId, leaseId)
  }
  override finishChildTurn(parentSessionId: string, correlationKey: string) {
    const route = this.boundChild(parentSessionId, correlationKey)
    if (!this.childLeases.has(route.childSessionId)) this.startChildTurn(parentSessionId, correlationKey)
    const leaseId = this.childLeases.get(route.childSessionId)!
    this.store.finishTurn({ sessionId: route.childSessionId, assistantMessageId: route.assistantMessageId, leaseId,
      outcome: { status: "completed", completedAt: 2 } })
    this.store.releaseTurnLease(route.childSessionId, leaseId)
    this.childLeases.delete(route.childSessionId)
  }
  override reopenChildTurn(parentSessionId: string, correlationKey: string) {
    const route = this.boundChild(parentSessionId, correlationKey)
    this.finishChildTurn(parentSessionId, correlationKey)
    void this.real.admitChildSession(parentSessionId, route.childSessionId, { observationId: `reopen:${correlationKey}`,
      providerKind: "claude-agent", toolCallId: correlationKey, status: "running" })
    this.startChildTurn(parentSessionId, correlationKey)
  }
  override rebindConnection(sessionId: string, connectionId: string) {
    const binding = this.store.getExecutionBinding(sessionId)
    if (!binding) throw new Error(`Session ${sessionId} has no binding`)
    this.store.bindSession({ ...binding, connectionId, agentSessionId: binding.upstreamSessionId })
  }
  override async publishSubagent(...args: Parameters<typeof this.real.publishSubagent>) {
    await this.real.publishSubagent(...args)
    this.subagents.push(args[1])
  }
  override async publishSubagentDiagnostic(...args: Parameters<typeof this.real.publishSubagentDiagnostic>) {
    await this.real.publishSubagentDiagnostic(...args)
    this.diagnostics.push(args[1])
  }
  override async rebind(sessionId: string, upstreamSessionId: string) {
    const binding = await this.real.rebind(sessionId, upstreamSessionId)
    const current = this.current.get(sessionId)
    if (current) Map.prototype.set.call(this.current, sessionId, { ...current, upstreamSessionId })
    this.bindings.set(sessionId, binding)
    return binding
  }
  override config(sessionId: string) { return this.real.config(sessionId) }
  override reportOwnerFailure(sessionId: string, error: unknown) { this.real.reportOwnerFailure(sessionId, error) }
}

registerBrokerBehaviorCases("runtime store", () => new StoreBehaviorPorts())

registerChildRequestCases("runtime store", () => new StoreBehaviorPorts())

registerChildOwnedRequestCases("runtime store", () => new StoreBehaviorPorts())

describe("store broker ports", () => {
  test("a permission that expires is published as expired, not as the person's rejection", async () => {
    const { ports, publishers } = setup()
    const streamed: unknown[] = []
    publishers.subscribeGlobal((event) => { streamed.push(event.payload) })
    const request = permission("expiring-permission")
    const pending: PendingRequest = { sessionId: "s1", request, askedAt: 1, upstreamSessionId: "up1" }
    await ports.publish({ id: "permission.asked:s1:expiring-permission", type: "permission.asked", properties: request.permission }, pending)
    await ports.persistAnswer(pending, { kind: "expired" }, false)
    expect(streamed).toContainEqual(expect.objectContaining({ type: "permission.expired", properties: { sessionID: "s1", requestID: "expiring-permission" } }))
    expect(streamed).not.toContainEqual(expect.objectContaining({ type: "permission.replied" }))
    expect(ports.readPending({ sessionId: "s1" })).toEqual([])
  })

  test("a question that expires is published as expired, not as the person's rejection", async () => {
    const { ports, publishers } = setup()
    const streamed: unknown[] = []
    publishers.subscribeGlobal((event) => { streamed.push(event.payload) })
    const request = question("expiring")
    const pending: PendingRequest = { sessionId: "s1", request, askedAt: 1, upstreamSessionId: "up1" }
    await ports.publish({ id: "question.asked:s1:expiring", type: "question.asked", properties: request.question }, pending)
    await ports.persistAnswer(pending, { kind: "expired" }, false)
    expect(streamed).toContainEqual(expect.objectContaining({ type: "question.expired", properties: { sessionID: "s1", requestID: "expiring" } }))
    expect(streamed).not.toContainEqual(expect.objectContaining({ type: "question.rejected" }))
    expect(ports.readPending({ sessionId: "s1" })).toEqual([])
  })

  test("a grant's automatic answer is recorded and streamed as the reply, though nobody was asked", async () => {
    const { store, ports, publishers } = setup()
    const streamed: unknown[] = []
    publishers.subscribeGlobal((event) => { streamed.push(event.payload) })
    const pending: PendingRequest = { sessionId: "s1", request: permission("granted"), askedAt: 1, upstreamSessionId: "up1" }
    await ports.persistAnswer(pending, { kind: "permission", decision: "allow_always" }, true)
    const replied = { type: "permission.replied", properties: { sessionID: "s1", requestID: "granted", reply: "always" } }
    expect(streamed).toContainEqual(expect.objectContaining(replied))
    expect(store.database().prepare<{ n: number }>(
      "SELECT count(*) AS n FROM runtime_journal WHERE session_id = 's1' AND type = 'permission.replied'").get()?.n).toBe(1)
  })

  test("first answer wins across a reopened store and directory reads are scoped", async () => {
    const { root, store, ports } = setup()
    const request = question("first")
    const pending: PendingRequest = { sessionId: "s1", request, askedAt: 10, upstreamSessionId: "up1" }
    await ports.publish({ id: "question.asked:s1:first", type: "question.asked", properties: request.question }, pending)
    expect(ports.readPending({ directory: "/work" })).toEqual([pending])
    expect(ports.readPending({ directory: "/other" })).toEqual([])
    await ports.persistAnswer(pending, { kind: "cancelled" }, false)
    await ports.persistAnswer(pending, { kind: "rejected" }, false)
    expect(ports.readAnswer("s1", "first")).toEqual({ kind: "cancelled" })
    store.close()
    const reopened = openTestRuntimeStore(root)
    opened.push({ store: reopened, root })
    expect(createStoreBrokerPorts(reopened, {
      ownerGeneration: "g1", patternEvaluator: async () => {}, publishers: createRuntimeEventHub(),
      reportOwnerFailure: (_id, error) => { throw error },
      retainLeasedTurnFailure: (_id, _turn, error) => { throw error },
    }).readAnswer("s1", "first")).toEqual({ kind: "cancelled" })
  })

  test("pending reads separate directories, duplicate native ids and startup requests", async () => {
    const { store, ports } = setup()
    store.bindSession({ owner: { kind: "machine-owner" }, sessionId: "s2", workspaceId: "w1", directory: "/other", connectionId: "c1",
      upstreamSessionId: "up2", agentSessionId: "up2" })
    const first: PendingRequest = { sessionId: "s1", request: question("shared"), askedAt: 1, upstreamSessionId: "up1" }
    const second: PendingRequest = { sessionId: "s2", request: { ...question("shared"),
      question: { ...question("shared").question, sessionID: "s2" } }, askedAt: 2, upstreamSessionId: "up2" }
    const start = { sessionId: "s3", workspaceId: "w1", directory: "/work", connectionId: "c1", operationId: "op" }
    store.sessionStarts.begin(start)
    const startup: PendingRequest = { sessionId: "s3", request: { ...question("startup"),
      question: { ...question("startup").question, sessionID: "s3" } }, askedAt: 3, start }
    for (const pending of [first, second, startup]) {
      if (pending.request.kind !== "question") throw new Error("Question expected")
      await ports.publish({ id: `question.asked:${pending.sessionId}:${pending.request.requestId}`,
        type: "question.asked", properties: pending.request.question }, pending)
    }
    expect(ports.readPending({ directory: "/work" }).map((row) => row.sessionId)).toEqual(["s1", "s3"])
    expect(ports.readPending({ directory: "/other" }).map((row) => row.sessionId)).toEqual(["s2"])
    await ports.persistAnswer(first, { kind: "rejected" }, false)
    expect(ports.readPending({ directory: "/other" }).map((row) => row.request.requestId)).toEqual(["shared"])
  })

  test("reply-only cancellation remains readable after reopening", async () => {
    const { root, store, ports } = setup()
    const pending: PendingRequest = { sessionId: "s1", request: question("unpublished"), askedAt: 1, upstreamSessionId: "up1" }
    await ports.persistAnswer(pending, { kind: "cancelled" }, false)
    expect(ports.readPending({ sessionId: "s1" })).toEqual([])
    store.close()
    const reopened = openTestRuntimeStore(root)
    opened.push({ store: reopened, root })
    const reopenedPorts = createStoreBrokerPorts(reopened, { ownerGeneration: "g1",
      patternEvaluator: async () => {}, publishers: createRuntimeEventHub(),
      reportOwnerFailure: (_id, error) => { throw error }, retainLeasedTurnFailure: (_id, _turn, error) => { throw error } })
    expect(reopenedPorts.readAnswer("s1", "unpublished")).toEqual({ kind: "cancelled" })
  })

  test("an aborted ask saves cancelled and a rebind keeps an earlier ask answerable", async () => {
    const { ports, authority } = setup()
    const owner = createRequestBroker(ports)
    const controller = new AbortController()
    const turn = createTurnBroker(owner, { authority, origin, signal: controller.signal })
    const aborted = turn.ask(question("abort"))
    await tick()
    controller.abort()
    expect(await aborted).toEqual({ kind: "cancelled" })
    expect(ports.readAnswer("s1", "abort")).toEqual({ kind: "cancelled" })
    expect(await owner.broker.answer("abort", { kind: "rejected" }, { sessionId: "s1" })).toMatchObject({ refusal: "stale" })
    const live = createTurnBroker(owner, { authority, origin, signal: new AbortController().signal })
    const before = live.ask(question("before"))
    await tick()
    const session = createSessionBroker(owner, { sessionId: "s1", workspaceId: "w1", directory: "/work", origin })
    await session.rebind("up2")
    const after = live.ask(question("after"))
    await tick()
    expect(owner.broker.list({ sessionId: "s1" }).map((row) => row.upstreamSessionId)).toEqual(["up1", "up2"])
    expect(await owner.broker.answer("before", { kind: "rejected" }, { sessionId: "s1" })).toMatchObject({ ok: true })
    expect(await owner.broker.answer("after", { kind: "rejected" }, { sessionId: "s1" })).toMatchObject({ ok: true })
    expect(await Promise.all([before, after])).toEqual([{ kind: "rejected" }, { kind: "rejected" }])
    expect(ports.currentTurnAuthority("s1")?.upstreamSessionId).toBe("up2")
  })

  test("answer and grant roll back together when the grant write fails", async () => {
    const { store, ports } = setup()
    const request = permission("grant")
    const pending: PendingRequest = { sessionId: "s1", request, askedAt: 10, upstreamSessionId: "up1" }
    await ports.publish({ id: "permission.asked:s1:grant", type: "permission.asked", properties: request.permission }, pending)
    store.database().exec("CREATE TRIGGER deny_broker_grant BEFORE UPDATE OF permission_state_json ON session BEGIN SELECT RAISE(ABORT, 'grant failed'); END")
    await expect(ports.persistAnswer(pending, { kind: "permission", decision: "allow_always" }, false, { sessionId: "s1", key: '["c1","run"]' })).rejects.toThrow("grant failed")
    expect(ports.readAnswer("s1", "grant")).toBeUndefined()
    expect(ports.readPermissionState("s1")?.brokerGrants).toBeUndefined()
    store.database().exec("DROP TRIGGER deny_broker_grant")
    await ports.persistAnswer(pending, { kind: "permission", decision: "allow_always" }, false, { sessionId: "s1", key: '["c1","run"]' })
    expect(ports.readAnswer("s1", "grant")).toEqual({ kind: "permission", decision: "allow_always" })
    expect(ports.readPermissionState("s1")?.brokerGrants).toEqual(['["c1","run"]'])
  })

  test("provider admission resolves before completion and settlement is terminal", async () => {
    const { store, ports } = setup()
    const lease = store.readTurnAuthority("s1")?.leaseId
    if (!lease) throw new Error("Missing initial lease")
    store.finishTurn({ sessionId: "s1", assistantMessageId: "t1", leaseId: lease, outcome: { status: "completed", completedAt: 10 } })
    store.releaseTurnLease("s1", lease)
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const cancelled = await ports.admitProviderTurn("s1", { reason: "goal" }, async (_turn, signal) => {
      await held
      if (signal.aborted) throw new Error("runtime cancelled")
    })
    expect(cancelled.admitted).toBe(true)
    ports.abortProviderTurn("s1")
    release()
    if (cancelled.admitted) expect(await cancelled.settled).toEqual({ state: "cancelled" })
    const completed = await ports.admitProviderTurn("s1", { reason: "provider" }, async (turn) => {
      await ports.drainProviderEvent("s1", turn, { event: { type: "finish", sessionId: "s1" } })
    })
    if (completed.admitted) expect(await completed.settled).toEqual({ state: "completed" })
    const failed = await ports.admitProviderTurn("s1", { reason: "provider" }, async () => { throw new Error("failed") })
    if (failed.admitted) expect(await failed.settled).toEqual({ state: "failed", error: "failed" })
  })

  test("a child request keyed by the agent id a result reported routes to that child before its spawn call is known", async () => {
    const { store, ports, authority } = setup()
    const owner = createRequestBroker(ports)
    const turn = createTurnBroker(owner, { authority, origin, signal: new AbortController().signal })
    const child = await turn.observeSubagent({ observationId: "result", providerKind: "claude-agent", providerId: "a64191ef39c5ecd63",
      toolCallId: "toolu_agent", transcript: { kind: "messages" }, status: "running", mode: "background" })
    if (!child) throw new Error("Missing child session")
    if (!store.acquireTurnLease(child.sessionId)) throw new Error("Expected child lease")
    store.startTurn({ sessionId: child.sessionId, assistantMessageId: child.assistantMessageId, agent: "general", parts: [] })
    const waiting = turn.ask({ ...permission("by-agent"), child: { correlationKey: "a64191ef39c5ecd63" } })
    await tick()
    expect(owner.broker.list({ sessionId: child.sessionId }).map((row) => row.request.requestId)).toEqual(["by-agent"])
    expect(await owner.broker.answer("by-agent", { kind: "permission", decision: "allow_once" }, { sessionId: child.sessionId })).toMatchObject({ ok: true })
    expect(await waiting).toEqual({ kind: "permission", decision: "allow_once" })
  })

  test("a provider turn asked for while the ending turn still holds the session is admitted when that turn releases it", async () => {
    const { store, ports } = setup()
    const lease = store.readTurnAuthority("s1")!.leaseId
    let decided = false
    const admission = ports.admitProviderTurn("s1", { reason: "provider" }, async (turn) => {
      await ports.drainProviderEvent("s1", turn, { event: { type: "finish", sessionId: "s1" } })
    }).finally(() => { decided = true })
    await tick()
    expect(decided).toBe(false)
    store.finishTurn({ sessionId: "s1", assistantMessageId: "t1", leaseId: lease, outcome: { status: "completed", completedAt: 10 } })
    store.releaseTurnLease("s1", lease)
    const result = await admission
    expect(result.admitted).toBe(true)
    if (result.admitted) expect(await result.settled).toEqual({ state: "completed" })
    expect(store.readTurnAuthority("s1")).toBeUndefined()
  })

  test("a provider turn waits for a running provider turn's settlement, not a second lease", async () => {
    const { store, ports } = setup()
    const lease = store.readTurnAuthority("s1")!.leaseId
    store.finishTurn({ sessionId: "s1", assistantMessageId: "t1", leaseId: lease, outcome: { status: "completed", completedAt: 10 } })
    store.releaseTurnLease("s1", lease)
    let finish!: () => void
    const running = new Promise<void>((resolve) => { finish = resolve })
    const order: string[] = []
    const first = await ports.admitProviderTurn("s1", { reason: "goal" }, async (turn) => {
      await running
      await ports.drainProviderEvent("s1", turn, { event: { type: "finish", sessionId: "s1" } })
      order.push("first ran")
    })
    const second = ports.admitProviderTurn("s1", { reason: "goal" }, async (turn) => {
      order.push("second ran")
      await ports.drainProviderEvent("s1", turn, { event: { type: "finish", sessionId: "s1" } })
    })
    await tick()
    expect(order).toEqual([])
    finish()
    const admitted = await second
    if (!first.admitted || !admitted.admitted) throw new Error("both provider turns must be admitted")
    expect(await first.settled).toEqual({ state: "completed" })
    expect(await admitted.settled).toEqual({ state: "completed" })
    expect(order).toEqual(["first ran", "second ran"])
  })

  test("a provider turn whose session is not released within the bound is refused busy and takes nothing later", async () => {
    const timers: (() => void)[] = []
    const clock = { now: () => 0, setTimeout: (callback: () => void) => timers.push(callback), clearTimeout: () => {} }
    const { store, ports } = setup({ clock })
    const lease = store.readTurnAuthority("s1")!.leaseId
    const admission = ports.admitProviderTurn("s1", { reason: "provider" }, async () => {})
    await tick()
    expect(timers).toHaveLength(1)
    timers[0]()
    expect(await admission).toEqual({ admitted: false, reason: "busy" })
    store.releaseTurnLease("s1", lease)
    expect(store.readTurnAuthority("s1")).toBeUndefined()
  })

  test("a provider turn on a session that never picked an agent or model runs the defaults a prompted turn runs", async () => {
    const { store, ports } = setup()
    const lease = store.readTurnAuthority("s1")?.leaseId
    if (!lease) throw new Error("Missing initial lease")
    store.finishTurn({ sessionId: "s1", assistantMessageId: "t1", leaseId: lease, outcome: { status: "completed", completedAt: 10 } })
    store.releaseTurnLease("s1", lease)
    store.updateSessionConfig("s1", { agent: null, model: null })
    const admitted = await ports.admitProviderTurn("s1", { reason: "goal" }, async (turn) => {
      await ports.drainProviderEvent("s1", turn, { event: { type: "finish", sessionId: "s1" } })
    })
    if (!admitted.admitted) throw new Error("Provider turn was not admitted")
    expect(await admitted.settled).toEqual({ state: "completed" })
    expect(store.getMessages("s1").at(-1)?.info).toMatchObject({ agent: "build", providerID: "claude", modelID: "default" })
  })

  test("a provider turn after a prompted one opens with a message its harness authored, so the session's latest turn still pages", async () => {
    const { store, ports } = setup()
    const first = store.readTurnAuthority("s1")?.leaseId
    if (!first) throw new Error("Missing initial lease")
    store.finishTurn({ sessionId: "s1", assistantMessageId: "t1", leaseId: first, outcome: { status: "completed", completedAt: 10 } })
    store.releaseTurnLease("s1", first)
    const prompted = store.acquireTurnLease("s1")
    if (!prompted) throw new Error("Missing prompted lease")
    const promptId = createMessageIds(() => Date.now() - 1)()
    store.startTurn({ sessionId: "s1", userMessageId: promptId, assistantMessageId: assistantMessageIdForTurn(promptId), agent: "general",
      model: { providerID: "anthropic", modelID: "test" }, parts: [{ type: "text", text: "start four agents" }] })
    store.finishTurn({ sessionId: "s1", assistantMessageId: assistantMessageIdForTurn(promptId), leaseId: prompted, outcome: { status: "completed", completedAt: 20 } })
    store.releaseTurnLease("s1", prompted)

    const admitted = await ports.admitProviderTurn("s1", { reason: "provider", detail: "Agent \"Audit\" finished" }, async (turn) => {
      await ports.drainProviderEvent("s1", turn, { event: { type: "text-delta", delta: "One task finished." } })
      await ports.drainProviderEvent("s1", turn, { event: { type: "finish", sessionId: "s1" } })
    })
    if (!admitted.admitted) throw new Error("Provider turn was not admitted")
    expect(await admitted.settled).toEqual({ state: "completed" })

    const page = store.getMessagePage("s1", { view: "latest-surface" })
    const [opening, reply] = page?.messages ?? []
    expect(opening?.info).toMatchObject({ role: "user", claxedo: { author: { id: "harness:claude", name: "Claude Code", kind: "agent" } } })
    expect(opening?.parts).toMatchObject([{ type: "text", text: "Agent \"Audit\" finished" }])
    expect(reply?.info).toMatchObject({ id: admitted.turn.assistantMessageId, role: "assistant", parentID: opening?.info.id })
    const laterPromptId = createMessageIds(() => Date.now() + 1)()
    expect([laterPromptId, opening!.info.id, promptId].sort()).toEqual([promptId, opening!.info.id, laterPromptId])
    expect(store.getMessagePage("s1", { view: "latest-turn" })?.messages.map((message) => message.info.id))
      .toEqual([opening?.info.id, admitted.turn.assistantMessageId])
  })

  test("a provider turn names its opening message after the reason it started", () => {
    expect(providerTurnNotice({ reason: "goal", detail: "ship the fix" })).toBe("Goal: ship the fix")
    expect(providerTurnNotice({ reason: "provider" })).toBe("Continued on its own")
    expect(harnessAuthor("cursor-acp")).toEqual({ id: "harness:cursor-acp", name: "cursor-acp", kind: "agent" })
  })

  test("a provider turn settles from its own terminal event, and one exhausted without it fails", async () => {
    const { store, ports } = setup()
    const lease = store.readTurnAuthority("s1")?.leaseId
    if (!lease) throw new Error("Missing initial lease")
    store.finishTurn({ sessionId: "s1", assistantMessageId: "t1", leaseId: lease, outcome: { status: "completed", completedAt: 10 } })
    store.releaseTurnLease("s1", lease)
    const settle = async (events: RoutedEvent[]) => {
      const admitted = await ports.admitProviderTurn("s1", { reason: "goal" }, async (turn) => {
        for (const event of events) await ports.drainProviderEvent("s1", turn, event)
      })
      if (!admitted.admitted) throw new Error("Provider turn was not admitted")
      return { settled: await admitted.settled, turn: store.getSession("s1")?.lastTurn }
    }
    expect(await settle([{ event: { type: "text-delta", delta: "unfinished" } }])).toMatchObject({
      settled: { state: "failed", error: "Harness stream ended without a terminal event" }, turn: { status: "failed", detail: { code: "missing_terminal_event" } } })
    expect(await settle([{ event: { type: "error", error: "provider refused" } }])).toMatchObject({
      settled: { state: "failed", error: "provider refused" }, turn: { status: "failed" } })
  })

  test("session events and outside-turn usage enter the existing journal projection", async () => {
    const { store, ports, publishers } = setup()
    const live: string[] = []
    publishers.subscribeGlobal((envelope) => live.push(envelope.payload.type))
    publishers.subscribeRuntime((envelope) => live.push(envelope.payload.type))
    await ports.publishSessionEvent("s1", { type: "harness-notice", code: "ready", message: "Ready", severity: "info" })
    ports.meterUsage({ sessionId: "s1", directory: "/work", assistantMessageId: "t1",
      usage: { type: "usage", contextSize: 100, contextUsed: 10,
        observation: { kind: "delta", tokens: { input: 5, output: 2, reasoning: null,
          cache: { read: 0, write: 0 } } } } })
    const rows = store.database().prepare<{ type: string }>(
      "SELECT type FROM runtime_journal WHERE session_id = ? AND kind = 'event' ORDER BY seq",
    ).all("s1")
    expect(rows.map((row) => row.type)).toContain("session.usage")
    expect(rows.map((row) => row.type)).toContain("runtime.diagnostic")
    expect(live).toContain("session.usage")
    expect(live).toContain("usage")
  })

  test("background work is pushed live when it changes, never journaled, and leaves turn admission alone", async () => {
    const { store, ports, publishers } = setup()
    const live: unknown[] = []
    publishers.subscribeGlobal((envelope) => live.push(envelope.payload))
    const runtime: string[] = []
    publishers.subscribeRuntime((envelope) => runtime.push(envelope.payload.type))
    const lease = store.readTurnAuthority("s1")?.leaseId
    if (!lease) throw new Error("Missing initial lease")
    store.finishTurn({ sessionId: "s1", assistantMessageId: "t1", leaseId: lease, outcome: { status: "completed", completedAt: 10 } })
    store.releaseTurnLease("s1", lease)

    await ports.publishSessionEvent("s1", { type: "background-work", agents: 1, shells: 0, other: 0 })
    await ports.publishSessionEvent("s1", { type: "background-work", agents: 1, shells: 0, other: 0 })
    await ports.publishSessionEvent("s1", { type: "background-work", agents: 2, shells: 1, other: 0 })
    expect(ports.backgroundWork.read("s1")).toEqual({ agents: 2, shells: 1, other: 0 })
    const admitted = await ports.admitProviderTurn("s1", { reason: "provider" }, async (turn) => {
      await ports.drainProviderEvent("s1", turn, { event: { type: "finish", sessionId: "s1" } })
    })
    expect(admitted.admitted).toBe(true)
    if (admitted.admitted) expect(await admitted.settled).toEqual({ state: "completed" })
    expect(ports.backgroundWork.read("s1")).toEqual({ agents: 2, shells: 1, other: 0 })
    ports.backgroundWork.retireAll()

    expect(ports.backgroundWork.read("s1")).toBeUndefined()
    expect(live.filter((payload) => (payload as { type: string }).type === "session.background-work")).toEqual([
      { type: "session.background-work", properties: { sessionID: "s1", agents: 1, shells: 0, other: 0 } },
      { type: "session.background-work", properties: { sessionID: "s1", agents: 2, shells: 1, other: 0 } },
      { type: "session.background-work", properties: { sessionID: "s1", agents: 0, shells: 0, other: 0 } },
    ])
    expect(runtime.filter((type) => type === "background-work")).toHaveLength(3)
    const journaled = store.database().prepare<{ type: string }>(
      "SELECT type FROM runtime_journal WHERE session_id = ? AND type = 'session.background-work'",
    ).all("s1")
    expect(journaled).toEqual([])
  })

  test("child provider events project into the admitted child session", async () => {
    const { store, ports, publishers } = setup()
    const owner = createRequestBroker(ports)
    const authority = ports.currentTurnAuthority("s1")
    if (!authority) throw new Error("Missing turn authority")
    const turn = createTurnBroker(owner, { authority, origin, signal: new AbortController().signal })
    const child = await turn.observeSubagent({ observationId: "child-start", providerKind: "acp",
      providerId: "upstream-child", transcript: { kind: "messages" }, status: "running" })
    if (!child) throw new Error("Missing child session")
    turn.associateChild("route-alias", child)
    const seen: string[] = []
    publishers.subscribeRuntime((envelope) => seen.push(envelope.sessionId))
    await ports.drainProviderEvent("s1", { turnId: "t1", assistantMessageId: "t1" }, { event: { type: "text-delta", delta: "child output" },
      route: { kind: "child", correlationKey: "route-alias" } })
    expect(seen).toContain(child.sessionId)
    const parentRows = store.database().prepare<{ type: string }>(
      "SELECT type FROM runtime_journal WHERE session_id = ? AND kind = 'event'",
    ).all("s1")
    const childRows = store.database().prepare<{ type: string }>(
      "SELECT type FROM runtime_journal WHERE session_id = ? AND kind = 'event'",
    ).all(child.sessionId)
    expect(childRows.length).toBeGreaterThan(0)
    expect(parentRows.map((row) => row.type)).not.toContain("message.part.updated")
  })

  test("a session broker delivers a background child's events while its parent has no turn", async () => {
    const { store, ports, publishers } = setup()
    const owner = createRequestBroker(ports)
    const session = createSessionBroker(owner, { sessionId: "s1", directory: "/work", workspaceId: "w1", origin })
    const child = await session.observeSubagent({ observationId: "background-start", providerKind: "claude-agent", toolCallId: "toolu_agent",
      toolCallRole: "spawn", mode: "background", transcript: { kind: "messages" }, status: "running" })
    if (!child) throw new Error("Missing child session")
    session.associateChild("toolu_agent", child)
    const leaseId = store.readTurnAuthority("s1")?.leaseId
    if (!leaseId) throw new Error("Missing turn lease")
    store.finishTurn({ sessionId: "s1", assistantMessageId: "t1", leaseId, outcome: { status: "completed", completedAt: 2 } })
    store.releaseTurnLease("s1", leaseId)
    expect(store.readTurnAuthority("s1")).toBeUndefined()
    const seen: string[] = []
    publishers.subscribeRuntime((envelope) => seen.push(envelope.sessionId))
    await session.publishChild({ event: { type: "text-delta", delta: "background output" }, route: { kind: "child", correlationKey: "toolu_agent" } })
    expect(seen).toEqual([child.sessionId])
    await expect(session.publishChild({ event: { type: "text-delta", delta: "parent text" } })).rejects.toThrow("child-routed")
  })

  test("subagent admission keeps revisions and child identity across restart", async () => {
    const { root, store, ports } = setup()
    const first = ports.subagentAdmissionStore.admit({
      parentSessionId: "s1", observation: { observationId: "o1", providerKind: "claude",
        providerId: "agent-1", transcript: { kind: "live" } },
      allocateKey: () => "key", allocateChildSessionId: () => "child",
    })
    await ports.publishSubagent("s1", first.event)
    ports.subagentAdmissionStore.markPublished("s1", "o1")
    const child = await ports.admitChildSession("s1", "child", { observationId: "o1" })
    store.close()
    const reopened = openTestRuntimeStore(root)
    opened.push({ store: reopened, root })
    const again = reopened.admit({
      parentSessionId: "s1", observation: { observationId: "o1", providerKind: "claude", providerId: "agent-1", transcript: { kind: "live" } },
      allocateKey: () => "wrong",
    })
    expect(again.published).toBe(true)
    const later = reopened.admit({
      parentSessionId: "s1", observation: { observationId: "o2", providerKind: "claude",
        providerId: "agent-1", status: "completed" }, allocateKey: () => "wrong",
    })
    expect(later.event.subagentKey).toBe(first.event.subagentKey)
    expect(later.event.revision).toBe(2)
    const replayChild = await createStoreBrokerPorts(reopened, {
      ownerGeneration: "g1", patternEvaluator: async () => {}, publishers: createRuntimeEventHub(),
      reportOwnerFailure: (_id, error) => { throw error },
      retainLeasedTurnFailure: (_id, _turn, error) => { throw error },
    }).admitChildSession("s1", "child", { observationId: "o1" })
    expect(replayChild).toEqual(child)
  })

  test("subagent updates and diagnostics reach the journal and live subscribers", async () => {
    const { store, ports, publishers } = setup()
    const live: string[] = []
    publishers.subscribeGlobal((envelope) => live.push(envelope.payload.type))
    publishers.subscribeRuntime((envelope) => live.push(envelope.payload.type))
    const admitted = ports.subagentAdmissionStore.admit({ parentSessionId: "s1",
      observation: { observationId: "event-output", providerKind: "claude", providerId: "agent" },
      allocateKey: () => "agent" })
    await ports.publishSubagent("s1", admitted.event)
    await ports.publishSubagentDiagnostic("s1", { code: "binding-unknown", message: "No child",
      severity: "warn", source: "subagent-admission" })
    const rows = store.database().prepare<{ type: string }>(
      "SELECT type FROM runtime_journal WHERE session_id = ? AND kind = 'event' ORDER BY seq",
    ).all("s1")
    expect(rows.map((row) => row.type)).toEqual(expect.arrayContaining(["subagent.updated", "runtime.diagnostic"]))
    expect(live).toEqual(expect.arrayContaining(["subagent.updated", "runtime.diagnostic", "diagnostic"]))
  })

  test("form patterns use the supplied evaluator before publication", async () => {
    const evaluated: unknown[] = []
    const { ports } = setup({ patternEvaluator: async (checks) => { evaluated.push(checks) } })
    const authority = ports.currentTurnAuthority("s1")
    if (!authority) throw new Error("Missing turn authority")
    const owner = createRequestBroker(ports)
    const turn = createTurnBroker(owner, { authority, origin, signal: new AbortController().signal })
    const waiting = turn.ask({ kind: "elicitation", requestId: "form-evaluator", mode: "form",
      message: "Value", schema: { type: "object", properties: { value: { type: "string", pattern: "^ok$" } } } })
    await tick()
    expect(evaluated).toEqual([[{ field: "value", pattern: "^ok$" }]])
    expect(ports.readPending({ sessionId: "s1" }).map((row) => row.request.requestId)).toEqual(["form-evaluator"])
    await owner.broker.answer("form-evaluator", { kind: "rejected" }, { sessionId: "s1" })
    await waiting
  })

  test("owner failures reach the supplied reporter with its receiver", () => {
    const reporter = {
      failures: [] as { sessionId: string; error: unknown }[],
      reportOwnerFailure(sessionId: string, error: unknown) { this.failures.push({ sessionId, error }) },
    }
    const { ports } = setup(reporter)
    const failure = new Error("provider failed")
    const owner = createRequestBroker(ports)
    createSessionBroker(owner, { sessionId: "s1", workspaceId: "w1", directory: "/work", origin }).reportFailure(failure)
    expect(reporter.failures).toEqual([{ sessionId: "s1", error: failure }])
  })

  test("a request deadline expires on the injected manual clock", async () => {
    let fire: (() => void) | undefined
    let delay: number | undefined
    const clock = { now: () => 10,
      setTimeout: (callback: () => void, ms: number) => { fire = callback; delay = ms; return callback },
      clearTimeout: (handle: unknown) => { if (handle === fire) fire = undefined },
    }
    const { ports } = setup({ clock })
    const authority = ports.currentTurnAuthority("s1")
    if (!authority) throw new Error("Missing turn authority")
    const owner = createRequestBroker(ports)
    const turn = createTurnBroker(owner, { authority, origin, signal: new AbortController().signal, expiresAt: 100 })
    const waiting = turn.ask({ ...question("deadline"), expiresAt: 20 })
    await tick()
    expect(delay).toBe(10)
    fire?.()
    expect(await waiting).toEqual({ kind: "expired" })
    expect(ports.readAnswer("s1", "deadline")).toEqual({ kind: "expired" })
  })

  test("start and goal use their existing session rows", async () => {
    const { store, ports } = setup()
    const binding = { sessionId: "s1", workspaceId: "w1", connectionId: "c1", directory: "/work", operationId: "op" }
    store.sessionStarts.begin(binding)
    expect(ports.readStart("s1")?.status).toBe("starting")
    const goal = { sessionId: "s1", objective: "Finish", status: "active" as const, createdAt: 1, updatedAt: 1 }
    await ports.publishGoal("s1", goal)
    expect(ports.readGoal("s1")).toEqual(goal)
  })
})

test("Goal publication commits state before subscribers observe it and also works without subscribers", async () => {
  const { store, ports, publishers } = setup()
  const session = createSessionBroker(createRequestBroker(ports), { sessionId: "s1", directory: "/work", workspaceId: "w1", origin })
  const goal = { sessionId: "s1", objective: "ship", status: "active" as const, createdAt: 1, updatedAt: 1 }
  const order: unknown[] = []
  const unsubscribe = publishers.subscribeGlobal(({ payload }) => {
    if (payload.type === "goal.updated" || payload.type === "goal.cleared") order.push(store.getGoal("s1"))
  })
  await session.goal.publish(goal)
  await session.goal.publish(null)
  expect(order).toEqual([goal, null])
  unsubscribe()
  await session.goal.publish(goal)
  expect(store.getGoal("s1")).toEqual(goal)
})

test("question cancellation publishes one rejection and preserves a sibling question", async () => {
  const { store, ports, authority, publishers } = setup()
  const owner = createRequestBroker(ports)
  const first = createTurnBroker(owner, { authority, origin, signal: new AbortController().signal })
  store.bindSession({ owner: { kind: "machine-owner" }, sessionId: "s2", directory: "/work", workspaceId: "w1", connectionId: "c1", upstreamSessionId: "up2", agentSessionId: "up2" })
  store.acquireTurnLease("s2")
  store.startTurn({ sessionId: "s2", assistantMessageId: "t2", agent: "general", parts: [] })
  const sibling = createTurnBroker(owner, { authority: ports.currentTurnAuthority("s2")!, origin, signal: new AbortController().signal })
  const published: unknown[] = []
  publishers.subscribeGlobal(({ payload }) => { if (payload.type === "question.rejected") published.push(payload) })
  const waiting = first.ask(question("q1"))
  const other = sibling.ask({ ...question("q2"), question: { ...question("q2").question, sessionID: "s2" } })
  await tick()
  await owner.endTurn(authority)
  expect(await waiting).toEqual({ kind: "cancelled" })
  expect(published).toEqual([expect.objectContaining({ type: "question.rejected", properties: { sessionID: "s1", requestID: "q1" } })])
  expect(store.listQuestions("/work").map((row) => row.id)).toEqual(["q2"])
  await owner.endTurn(ports.currentTurnAuthority("s2")!)
  await other
})

test("provider admission refused as busy never runs its provisional producer", async () => {
  const timers: (() => void)[] = []
  const { ports } = setup({ clock: { now: () => 0, setTimeout: (callback: () => void) => timers.push(callback), clearTimeout: () => {} } })
  const session = createSessionBroker(createRequestBroker(ports), { sessionId: "s1", directory: "/work", workspaceId: "w1", origin })
  let runs = 0
  const admission = session.admitProviderTurn({ reason: "provider" }, async function* () {
    runs++
    yield { event: { type: "finish", sessionId: "s1" } }
  })
  await tick()
  for (const fire of timers) fire()
  expect(await admission).toEqual({ admitted: false, reason: "busy" })
  expect(runs).toBe(0)
})

test("an unchanged Goal snapshot does not write or publish a duplicate state", async () => {
  const { store, ports, publishers } = setup()
  const session = createSessionBroker(createRequestBroker(ports), { sessionId: "s1", directory: "/work", workspaceId: "w1", origin })
  const goal = { sessionId: "s1", objective: "ship", status: "active" as const, createdAt: 1, updatedAt: 1 }
  const order: unknown[] = []
  publishers.subscribeGlobal(({ payload }) => { if (payload.type === "goal.updated") order.push(store.getGoal("s1")) })
  await session.goal.publish(goal)
  await session.goal.publish({ ...goal })
  expect(order).toEqual([goal])
  const rows = store.database().prepare<{ count: number }>("SELECT COUNT(*) AS count FROM runtime_journal WHERE session_id = ? AND type = 'goal.updated'").get("s1")
  expect(rows?.count).toBe(1)
})

function refusedProviderTurn(stage: "start" | "finish", retains = true) {
  const failures: Array<{ sessionId: string; error: unknown }> = []
  const retained: Array<{ sessionId: string; turn: { leaseId: string; assistantMessageId: string; outcome: unknown }; error: unknown }> = []
  const { store, ports } = setup({
    reportOwnerFailure: (sessionId, error) => { failures.push({ sessionId, error }) },
    retainLeasedTurnFailure: (sessionId, turn, error) => { retained.push({ sessionId, turn, error }); return retains },
  })
  const leaseId = store.readTurnAuthority("s1")!.leaseId
  store.finishTurn({ sessionId: "s1", leaseId, outcome: { status: "completed", completedAt: 1 } })
  store.releaseTurnLease("s1", leaseId)
  const start = store.startTurn.bind(store)
  const finish = store.finishTurn.bind(store)
  const error = new Error(`${stage} write refused`)
  if (stage === "start") store.startTurn = () => { throw error }
  else store.finishTurn = () => { throw error }
  const broker = createSessionBroker(createRequestBroker(ports), { sessionId: "s1", directory: "/work", workspaceId: "w1", origin })
  return {
    store, failures, retained, error,
    admission: () => broker.admitProviderTurn({ reason: "goal" }, async function* () { yield { event: { type: "finish", sessionId: "s1" } } }),
    restore: () => { store.startTurn = start; store.finishTurn = finish },
  }
}

test("a refused provider turn start releases its lease and reports its session owner once", async () => {
  const f = refusedProviderTurn("start")
  try {
    await expect(f.admission()).rejects.toThrow("start write refused")
    expect(f.store.readTurnAuthority("s1")).toBeUndefined()
    const replacement = f.store.acquireTurnLease("s1")
    expect(replacement).toBeString()
    f.store.releaseTurnLease("s1", replacement!)
    expect(f.failures).toEqual([{ sessionId: "s1", error: f.error }])
    expect(f.retained).toEqual([])
  } finally { f.restore() }
})

test("a refused provider turn finish keeps its lease and retains the turn for its session owner once", async () => {
  const f = refusedProviderTurn("finish")
  try {
    const result = await f.admission()
    expect(result.admitted).toBe(true)
    if (!result.admitted) return
    expect(await result.settled).toEqual({ state: "failed", error: "finish write refused" })
    const leaseId = f.store.readTurnAuthority("s1")?.leaseId
    expect(leaseId).toBeString()
    expect(f.store.acquireTurnLease("s1")).toBeUndefined()
    expect(f.retained).toEqual([{ sessionId: "s1", turn: { leaseId: leaseId!, assistantMessageId: result.turn.assistantMessageId,
      outcome: { status: "completed", completedAt: expect.any(Number) } }, error: f.error }])
    expect(f.failures).toEqual([])
  } finally { f.restore() }
})

test("a refused provider turn finish that no owner can retain releases its lease and reports the refusal", async () => {
  const f = refusedProviderTurn("finish", false)
  try {
    const result = await f.admission()
    if (!result.admitted) throw new Error("expected an admitted provider turn")
    expect(await result.settled).toEqual({ state: "failed", error: "finish write refused" })
    expect(f.store.readTurnAuthority("s1")).toBeUndefined()
    expect(f.retained).toHaveLength(1)
    expect(f.failures).toEqual([{ sessionId: "s1", error: f.error }])
  } finally { f.restore() }
})

test("Goal publication retries a failed durable event and deduplicates only committed snapshots", async () => {
  const { store, ports, publishers } = setup()
  const events: string[] = []
  publishers.subscribeGlobal(({ payload }) => { events.push(payload.type) })
  const snapshot = { sessionId: "s1", objective: "ship", status: "active" as const, createdAt: 1, updatedAt: 1 }
  store.database().exec("CREATE TRIGGER deny_goal_event BEFORE INSERT ON runtime_journal WHEN NEW.type = 'goal.updated' BEGIN SELECT RAISE(ABORT, 'goal event refused'); END")
  await expect(ports.publishGoal("s1", snapshot)).rejects.toThrow("goal event refused")
  expect(events).toEqual([])
  expect(store.getGoal("s1")).toBeNull()
  store.database().exec("DROP TRIGGER deny_goal_event")
  await ports.publishGoal("s1", snapshot)
  await ports.publishGoal("s1", { ...snapshot })
  expect(events).toEqual(["goal.updated"])
  expect(store.getGoal("s1")).toEqual(snapshot)
})

test("public form cancellation defeats validation and emits one durable rejection", async () => {
  let release!: () => void
  let reached!: () => void
  let validationSignal: AbortSignal | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  const validating = new Promise<void>((resolve) => { reached = resolve })
  const { store, ports, authority, publishers } = setup({ patternEvaluator: async (checks, signal) => {
    if (!checks.some((check) => check.value !== undefined)) return
    validationSignal = signal
    reached()
    await gate
  } })
  const events: string[] = []
  publishers.subscribeGlobal(({ payload }) => { events.push(payload.type) })
  const owner = createRequestBroker(ports)
  const surface = createRequestSurface({ store, broker: owner })
  const turn = createTurnBroker(owner, { authority, origin, signal: new AbortController().signal })
  const response = turn.ask({ kind: "elicitation", requestId: "cancel-form", mode: "form", message: "Answer",
    schema: { type: "object", properties: { answer: { type: "string", pattern: "." } } } })
  await tick()
  const answer = surface.questions.answer("cancel-form", [['{"answer":"yes"}']], "s1").then(() => undefined, (error: unknown) => error)
  try {
    await validating
    await expect(surface.questions.answer("cancel-form", [['{"answer":"yes"}']], "s1")).rejects.toMatchObject({ code: "validation_busy" })
    await owner.endTurn(authority)
    expect(validationSignal?.aborted).toBe(true)
    release()
    expect(await answer).toMatchObject({ refusal: "duplicate" })
    expect(await response).toEqual({ kind: "cancelled" })
    expect(events).toEqual(["question.asked", "question.rejected"])
    expect(await surface.questions.list("/work")).toEqual([])
    expect(store.database().prepare<{ count: number }>("SELECT COUNT(*) AS count FROM runtime_journal WHERE type = 'question.rejected'").get()?.count).toBe(1)
  } finally { release(); await answer }
})

test("public form reply retains its resolver after a durable failure and publishes exactly once", async () => {
  const failures: unknown[] = []
  const { store, ports, authority, publishers } = setup({ reportOwnerFailure: (_sessionId, error) => { failures.push(error) } })
  const events: string[] = []
  publishers.subscribeGlobal(({ payload }) => { events.push(payload.type) })
  const owner = createRequestBroker(ports)
  const surface = createRequestSurface({ store, broker: owner })
  const turn = createTurnBroker(owner, { authority, origin, signal: new AbortController().signal })
  const response = turn.ask({ kind: "elicitation", requestId: "retry-form", mode: "form", message: "Answer",
    schema: { type: "object", properties: { count: { type: "integer" }, approach: { type: "string" } } } })
  let answered = false
  void response.then(() => { answered = true })
  await tick()
  store.database().exec("CREATE TRIGGER deny_form_reply BEFORE INSERT ON runtime_journal WHEN NEW.type = 'question.replied' BEGIN SELECT RAISE(ABORT, 'form reply refused'); END")
  const answers = [[JSON.stringify({ count: 2, approach: "safe" })]]
  await expect(surface.questions.answer("retry-form", answers, "s1")).rejects.toMatchObject({ refusal: "persistence", retryable: true })
  expect(answered).toBe(false)
  expect(await surface.questions.list("/work")).toHaveLength(1)
  expect(events).toEqual(["question.asked"])
  expect(failures).toHaveLength(1)
  store.database().exec("DROP TRIGGER deny_form_reply")
  await surface.questions.answer("retry-form", answers, "s1")
  expect(await response).toEqual({ kind: "form", values: { count: 2, approach: "safe" } })
  expect(events).toEqual(["question.asked", "question.replied"])
  expect(await surface.questions.list("/work")).toEqual([])
  await expect(surface.questions.answer("retry-form", answers, "s1")).rejects.toMatchObject({ refusal: "duplicate" })
  expect(store.database().prepare<{ count: number }>("SELECT COUNT(*) AS count FROM runtime_journal WHERE type = 'question.replied'").get()?.count).toBe(1)
})
