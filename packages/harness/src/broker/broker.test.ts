import { describe, expect, test } from "bun:test"
import { ElicitationValidationError, UnknownHostSubagentKeyError, type AgentSessionStartBinding, type SubagentObservation } from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeEvent, SubagentUpdatedEvent } from "@claxedo/agent-event-runtime/contracts"
import type { PendingRequest, RequestAnswer } from "../contract/broker"
import type { BrokerEvent, BrokerPorts, SubagentAdmissionStore, TurnAuthority } from "./ports"
import { createRequestBroker, createSessionBroker, createTurnBroker } from "./index"
import { chooseBrokerPermissionOption } from "./options"

const origin = { actor: { kind: "machine-owner" as const }, via: "loopback" as const, reissued: false }
const authority: TurnAuthority = {
  sessionId: "s1", workspaceId: "w1", directory: "/work", connectionId: "c1",
  upstreamSessionId: "up1", ownerGeneration: "g1", turnId: "t1",
}
const permission = (id: string, grantKey?: string, options?: { optionId: string; kind: "allow_once" | "allow_always" | "reject_once" | "reject_always"; name: string }[]) => ({
  kind: "permission" as const, requestId: id, grantKey, options,
  permission: { id, sessionID: "s1", permission: "execute", patterns: [], always: [], metadata: {},
    ...(options === undefined ? {} : { options: options.map((option) => ({ id: option.optionId, label: option.name })) }) },
})
const question = (id: string) => ({
  kind: "question" as const, requestId: id,
  question: { id, sessionID: "s1", questions: [{ header: "Question", question: "Continue?", options: [], custom: true }] },
})

class MemoryPorts implements BrokerPorts {
  nowValue = 10
  timers = new Map<number, () => void>()
  timerDelays = new Map<number, number>()
  nextTimer = 0
  current = new Map<string, TurnAuthority>([["s1", authority]])
  saved: { pending: PendingRequest; answer: RequestAnswer; automatic: boolean }[] = []
  answers = new Map<string, RequestAnswer>()
  published: BrokerEvent[] = []
  states = new Map<string, Record<string, unknown>>()
  failPersist = false
  failGrant = false
  startStatus: "starting" | "created" | "failed" = "starting"
  startBinding?: AgentSessionStartBinding
  pendingRows = new Map<string, PendingRequest>()
  publishGate?: Promise<void>
  onReadPermissionState?: () => void
  failures: unknown[] = []
  evaluated?: Promise<void>
  evaluatorSignal?: AbortSignal
  evaluatedChecks: unknown[] = []
  subagents: SubagentUpdatedEvent[] = []
  diagnostics: unknown[] = []
  children = new Map<string, { sessionId: string; assistantMessageId: string; created: number }>()
  admissionRows = new Map<string, { observation: SubagentObservation; event: SubagentUpdatedEvent; published: boolean }>()
  revisions = new Map<string, number>()
  readonly subagentAdmissionStore: SubagentAdmissionStore = {
    admit: ({ parentSessionId, observation, allocateKey, allocateChildSessionId }) => {
      const id = `${parentSessionId}:${observation.observationId}`
      const prior = this.admissionRows.get(id)
      if (prior) {
        if (JSON.stringify(prior.observation) !== JSON.stringify(observation)) throw new Error("conflicting content")
        return { parentSessionId, observationId: observation.observationId, event: prior.event, published: prior.published }
      }
      const host = observation.subagentKey ? [...this.admissionRows.values()].find((row) =>
        row.event.subagentKey === observation.subagentKey && row.event.childSessionId) : undefined
      if (observation.providerKind === "claxedo" && observation.toolCallId && !host) {
        throw new UnknownHostSubagentKeyError(parentSessionId, observation.observationId, observation.subagentKey)
      }
      const related = host ?? [...this.admissionRows.values()].find((row) =>
        observation.providerId && row.observation.providerId === observation.providerId)
      const key = observation.subagentKey ?? related?.event.subagentKey ?? allocateKey()
      const revision = (this.revisions.get(key) ?? 0) + 1
      this.revisions.set(key, revision)
      const childSessionId = related?.event.childSessionId ?? observation.childSessionId ?? allocateChildSessionId?.()
      const event: SubagentUpdatedEvent = { type: "subagent-updated", subagentKey: key, revision,
        ...(observation.providerKind ? { providerKind: observation.providerKind } : {}),
        ...(observation.providerId ? { providerId: observation.providerId } : {}),
        ...(observation.toolCallId ? { toolCallId: observation.toolCallId, toolCallRole: observation.toolCallRole } : {}),
        ...(observation.status ? { status: observation.status } : {}),
        ...(childSessionId ? { childSessionId } : {}) }
      this.admissionRows.set(id, { observation, event, published: false })
      return { parentSessionId, observationId: observation.observationId, event, published: false }
    },
    markPublished: (parentSessionId, observationId) => {
      const row = this.admissionRows.get(`${parentSessionId}:${observationId}`)
      if (!row) throw new Error("unknown observation")
      row.published = true
    },
  }
  drained: unknown[] = []
  readonly clock = {
    now: () => this.nowValue,
    setTimeout: (callback: () => void, ms: number) => {
      const id = ++this.nextTimer
      this.timers.set(id, callback)
      this.timerDelays.set(id, ms)
      return id
    },
    clearTimeout: (id: unknown) => { this.timers.delete(id as number) },
  }
  readonly services = {
    patternEvaluator: async (checks: unknown, signal?: AbortSignal) => {
      this.evaluatedChecks.push(checks)
      this.evaluatorSignal = signal
      await this.evaluated
    },
  }
  currentTurnAuthority(sessionId: string) { return this.current.get(sessionId) }
  async persistAnswer(pending: PendingRequest, answer: RequestAnswer, automatic: boolean, grantKey?: string): Promise<readonly AgentRuntimeEvent[]> {
    if (this.failPersist) throw new Error("disk unavailable")
    if (grantKey && this.failGrant) throw new Error("grant write unavailable")
    if (grantKey) {
      const state = this.states.get(pending.sessionId) ?? {}
      const grants = (state.brokerGrants as string[] | undefined) ?? []
      this.states.set(pending.sessionId, { ...state, brokerGrants: [...new Set([...grants, grantKey])] })
    }
    this.saved.push({ pending, answer, automatic })
    this.answers.set(JSON.stringify([pending.sessionId, pending.request.requestId]), answer)
    this.pendingRows.delete(JSON.stringify([pending.sessionId, pending.request.requestId]))
    return []
  }
  readAnswer(sessionId: string, requestId: string) { return this.answers.get(JSON.stringify([sessionId, requestId])) }
  async publish(event: BrokerEvent) {
    await this.publishGate
    this.published.push(event)
  }
  readPending(scope: { sessionId: string } | { directory: string }) {
    return [...this.pendingRows.values()].filter((row) => "sessionId" in scope ? row.sessionId === scope.sessionId : row.start?.directory === scope.directory)
  }
  readStart(sessionId: string) {
    const binding = this.startBinding
    if (!binding || binding.sessionId !== sessionId) return undefined
    if (this.startStatus === "starting") return { binding, status: "starting" as const, createdAt: 1, updatedAt: 1 }
    if (this.startStatus === "created") return { binding, status: "created" as const, upstreamSessionId: "up1", createdAt: 1, updatedAt: 2 }
    return { binding, status: "failed" as const, error: "failed", createdAt: 1, updatedAt: 2 }
  }
  readPermissionState(sessionId: string) {
    this.onReadPermissionState?.()
    return this.states.get(sessionId)
  }
  readGoal(_sessionId: string) { return null }
  async publishGoal(_sessionId: string, _snapshot: null) {}
  async admitProviderTurn(_sessionId: string, _input: unknown, run: (id: string, signal: AbortSignal) => Promise<void>) {
    await run("t1", new AbortController().signal)
    return { admitted: true as const, turnId: "t1" }
  }
  async drainProviderEvent(_sessionId: string, _turnId: string, event: unknown) { this.drained.push(event) }
  meterUsage(_usage: unknown) {}
  async admitChildSession(_sessionId: string, childSessionId: string, _observation: SubagentObservation) {
    return this.children.get(childSessionId) ?? { sessionId: childSessionId, assistantMessageId: "assistant", created: 10 }
  }
  async publishSubagent(_sessionId: string, event: SubagentUpdatedEvent) { this.subagents.push(event) }
  async publishSubagentDiagnostic(_sessionId: string, diagnostic: unknown) {
    this.diagnostics.push(diagnostic)
  }
  async rebind(_sessionId: string, _upstream: string) {}
  async persistHandoff(_sessionId: string, _context: unknown) {}
  config(_sessionId: string): never { throw new Error("unused") }
  reportOwnerFailure(_sessionId: string, error: unknown) { this.failures.push(error) }
}

function setup() {
  const ports = new MemoryPorts()
  const owner = createRequestBroker(ports)
  const controller = new AbortController()
  const turn = createTurnBroker(owner, { authority, origin, signal: controller.signal })
  return { ports, owner, controller, turn }
}

const tick = async () => { for (let index = 0; index < 12; index++) await Promise.resolve() }

describe("request broker", () => {
  test("save before release and retry after persistence failure", async () => {
    const { ports, owner, turn } = setup()
    const waiting = turn.ask(permission("p1"))
    await tick()
    ports.failPersist = true
    expect(await owner.broker.answer("p1", { kind: "permission", decision: "allow_once" }, { sessionId: "s1" })).toMatchObject({ ok: false, refusal: "persistence", retryable: true })
    expect(owner.broker.list({ sessionId: "s1" })).toHaveLength(1)
    let released = false
    void waiting.then(() => { released = true })
    await tick()
    expect(released).toBe(false)
    ports.failPersist = false
    expect(await owner.broker.answer("p1", { kind: "permission", decision: "allow_once" }, { sessionId: "s1" })).toMatchObject({ ok: true })
    expect(await waiting).toEqual({ kind: "permission", decision: "allow_once" })
  })

  test("stale, duplicate, foreign and unoffered do not mutate", async () => {
    const { ports, owner, turn } = setup()
    expect(await owner.broker.answer("missing", { kind: "rejected" }, { sessionId: "s1" })).toMatchObject({ refusal: "stale" })
    const waiting = turn.ask(permission("p2", undefined, [{ optionId: "once", kind: "allow_once", name: "Once" }]))
    await tick()
    expect(await owner.broker.answer("p2", { kind: "permission", decision: "allow_once" }, { sessionId: "s2" })).toMatchObject({ refusal: "foreign" })
    ports.current.set("s1", { ...authority, workspaceId: "w2" })
    expect(await owner.broker.answer("p2", { kind: "permission", decision: "allow_once" }, { sessionId: "s1" })).toMatchObject({ refusal: "foreign" })
    ports.current.set("s1", authority)
    expect(await owner.broker.answer("p2", { kind: "permission", decision: "allow_once", optionId: "wrong" }, { sessionId: "s1" })).toMatchObject({ refusal: "unoffered" })
    expect(ports.saved).toHaveLength(0)
    expect(owner.broker.list({ sessionId: "s1" })).toHaveLength(1)
    expect(await owner.broker.answer("p2", { kind: "permission", decision: "allow_once" }, { sessionId: "s1" })).toMatchObject({ ok: true })
    expect(await waiting).toEqual({ kind: "permission", decision: "allow_once", optionId: "once" })
    expect(await owner.broker.answer("p2", { kind: "rejected" }, { sessionId: "s1" })).toMatchObject({ refusal: "duplicate" })
  })

  test("abort answers every turn request cancelled", async () => {
    const { ports, owner, controller, turn } = setup()
    const first = turn.ask(permission("p3"))
    const second = turn.ask(question("q3"))
    await tick()
    controller.abort()
    expect(await first).toEqual({ kind: "cancelled" })
    expect(await second).toEqual({ kind: "cancelled" })
    expect(owner.broker.list({ sessionId: "s1" })).toHaveLength(0)
    expect(ports.saved.map((item) => item.answer)).toEqual([{ kind: "cancelled" }, { kind: "cancelled" }])
  })

  test("grants are silent for an identical request and scoped to one session", async () => {
    const { ports, owner, turn } = setup()
    const first = turn.ask(permission("p4", "command:a"))
    await tick()
    await owner.broker.answer("p4", { kind: "permission", decision: "allow_always" }, { sessionId: "s1" })
    await first
    const asked = ports.published.length
    expect(await turn.ask(permission("p5", "command:a"))).toEqual({ kind: "permission", decision: "allow_always" })
    expect(ports.published.slice(asked).map((event) => event.type)).toEqual(["permission.auto-answered"])
    const different = turn.ask(permission("p6", "command:b"))
    await tick()
    expect(owner.broker.list({ sessionId: "s1" })).toHaveLength(1)
    await owner.broker.answer("p6", { kind: "rejected" }, { sessionId: "s1" })
    await different
    const other = { ...authority, sessionId: "s2", turnId: "t2" }
    ports.current.set("s2", other)
    const otherTurn = createTurnBroker(owner, { authority: other, origin, signal: new AbortController().signal })
    const otherPermission = permission("p7", "command:a")
    otherPermission.permission.sessionID = "s2"
    const foreign = otherTurn.ask(otherPermission)
    await tick()
    expect(owner.broker.list({ sessionId: "s2" })).toHaveLength(1)
    await owner.broker.answer("p7", { kind: "rejected" }, { sessionId: "s2" })
    await foreign
  })

  test("failed grant write keeps the permission pending and unreleased", async () => {
    const { ports, owner, turn } = setup()
    const waiting = turn.ask(permission("grant-failure", "command:a"))
    await tick()
    ports.failGrant = true
    expect(await owner.broker.answer("grant-failure", { kind: "permission", decision: "allow_always" }, { sessionId: "s1" })).toMatchObject({ refusal: "persistence", retryable: true })
    expect(owner.broker.list({ sessionId: "s1" })).toHaveLength(1)
    let released = false
    void waiting.then(() => { released = true })
    await tick()
    expect(released).toBe(false)
    ports.failGrant = false
    expect(await owner.broker.answer("grant-failure", { kind: "permission", decision: "allow_always" }, { sessionId: "s1" })).toMatchObject({ ok: true })
    expect(await waiting).toEqual({ kind: "permission", decision: "allow_always" })
  })

  test("option substitution never widens allow once", () => {
    const option = (kind: "allow_once" | "allow_always" | "reject_once" | "reject_always") => ({ optionId: kind, kind, name: kind })
    expect(chooseBrokerPermissionOption("allow_once", [option("allow_always")])).toBeUndefined()
    expect(chooseBrokerPermissionOption("allow_always", [option("allow_once")])?.kind).toBe("allow_once")
    expect(chooseBrokerPermissionOption("deny", [option("reject_always")])?.kind).toBe("reject_always")
    expect(chooseBrokerPermissionOption("reject_always", [option("reject_once")])?.kind).toBe("reject_once")
    expect(chooseBrokerPermissionOption("allow_once", [])).toBeUndefined()
  })

  test("start request has operation, workspace, connection and directory authority", async () => {
    const { ports, owner } = setup()
    const start: AgentSessionStartBinding = { sessionId: "s1", operationId: "op1", workspaceId: "w1", connectionId: "c1", directory: "/work" }
    ports.startBinding = start
    const context = { sessionId: "s1", directory: "/work", workspaceId: "w1", connectionId: "c1", operationId: "op1", start, origin }
    const session = createSessionBroker(owner, context)
    const waiting = session.ask(question("start1"))
    await tick()
    expect(owner.broker.list({ directory: "/work" })[0]?.start).toEqual(start)
    for (const field of ["operationId", "workspaceId", "connectionId", "directory"] as const) {
      expect(await owner.broker.answer("start1", { kind: "rejected" }, { start: { ...start, [field]: "wrong" } })).toMatchObject({ refusal: "foreign" })
    }
    expect(await owner.broker.answer("start1", { kind: "rejected" }, { sessionId: "s1" })).toMatchObject({ refusal: "foreign" })
    expect(ports.saved).toHaveLength(0)
    await owner.broker.answer("start1", { kind: "rejected" }, { start })
    expect(await waiting).toEqual({ kind: "rejected" })
  })

  test("expiry settles with expired", async () => {
    const { ports, owner } = setup()
    const turn = createTurnBroker(owner, { authority, origin, signal: new AbortController().signal, expiresAt: 20 })
    const waiting = turn.ask(question("expiry"))
    await tick()
    for (const callback of ports.timers.values()) callback()
    expect(await waiting).toEqual({ kind: "expired" })
    expect(owner.broker.list({ sessionId: "s1" })).toHaveLength(0)
  })

  test("form validation rejects invalid, busy and cancelled replies", async () => {
    const { ports, owner, controller, turn } = setup()
    const request = { kind: "elicitation" as const, requestId: "form", mode: "form" as const, message: "Name",
      schema: { type: "object", properties: { name: { type: "string", pattern: "^[A-Z]+$" } }, required: ["name"] } }
    const waiting = turn.ask(request)
    await tick()
    await expect(owner.broker.answer("form", { kind: "form", values: { name: 3 } }, { sessionId: "s1" })).rejects.toMatchObject({ code: "invalid_answer" })
    let release!: () => void
    ports.evaluated = new Promise<void>((resolve) => { release = resolve })
    const validating = owner.broker.answer("form", { kind: "form", values: { name: "VALID" } }, { sessionId: "s1" })
    await tick()
    await expect(owner.broker.answer("form", { kind: "form", values: { name: "OTHER" } }, { sessionId: "s1" })).rejects.toMatchObject({ code: "validation_busy" })
    controller.abort()
    release()
    expect(await waiting).toEqual({ kind: "cancelled" })
    expect(await validating).toMatchObject({ refusal: "duplicate" })
    expect(ports.evaluatorSignal?.aborted).toBe(true)
    expect(ports.saved.at(-1)?.answer).toEqual({ kind: "cancelled" })
    expect(ElicitationValidationError).toBeDefined()
  })

  test("provider turns drain each event and subagents reuse a child", async () => {
    const { ports, owner, turn } = setup()
    const child = { sessionId: "child", assistantMessageId: "assistant", created: 10 }
    ports.children.set(child.sessionId, child)
    turn.associateChild("agent", child)
    expect(await turn.observeSubagent({ observationId: "o1", subagentKey: "agent", providerKind: "claxedo", toolCallId: "tool", toolCallRole: "spawn" })).toEqual(child)
    expect(await turn.observeSubagent({ observationId: "o1", subagentKey: "agent", providerKind: "claxedo", toolCallId: "tool", toolCallRole: "spawn" })).toEqual(child)
    expect(ports.subagents).toHaveLength(1)
    await expect(turn.observeSubagent({ observationId: "o1", subagentKey: "agent", providerKind: "claxedo", toolCallId: "tool", toolCallRole: "interaction" })).rejects.toThrow("conflicting content")
    const session = createSessionBroker(owner, { sessionId: "s1", workspaceId: "w1", directory: "/work", origin })
    expect(await session.admitProviderTurn({ reason: "goal" }, async function* () {
      yield { event: { type: "text-delta", delta: "hello" } }
    })).toEqual({ admitted: true, turnId: "t1" })
    expect(ports.drained).toHaveLength(1)
  })

  test("subagent admission survives broker restart without resetting revisions or republishing", async () => {
    const { ports, turn } = setup()
    await turn.observeSubagent({ observationId: "durable-1", providerKind: "claude", providerId: "agent-1", status: "running" })
    const restarted = createRequestBroker(ports)
    const later = createTurnBroker(restarted, { authority, origin, signal: new AbortController().signal })
    await later.observeSubagent({ observationId: "durable-1", providerKind: "claude", providerId: "agent-1", status: "running" })
    await later.observeSubagent({ observationId: "durable-2", providerKind: "claude", providerId: "agent-1", status: "completed" })
    expect(ports.subagents.map((event) => event.revision)).toEqual([1, 2])
    expect(ports.subagents[0]?.subagentKey).toBe(ports.subagents[1]?.subagentKey)
  })

  test("an unknown claxedo host binding publishes a diagnostic and continues", async () => {
    const { ports, turn } = setup()
    expect(await turn.observeSubagent({ observationId: "unknown-host", subagentKey: "missing", providerKind: "claxedo", toolCallId: "tool", toolCallRole: "spawn" })).toBeUndefined()
    expect(ports.diagnostics).toContainEqual(expect.objectContaining({ code: "subagent-binding-unknown" }))
    expect(ports.subagents).toHaveLength(0)
  })

  test("a host child binding survives broker restart", async () => {
    const { ports, turn } = setup()
    const child = { sessionId: "durable-child", assistantMessageId: "assistant", created: 10 }
    ports.children.set(child.sessionId, child)
    turn.associateChild("host-agent", child)
    const restarted = createRequestBroker(ports)
    const later = createTurnBroker(restarted, { authority, origin, signal: new AbortController().signal })
    expect(await later.observeSubagent({ observationId: "host-after-restart", subagentKey: "host-agent", providerKind: "claxedo", toolCallId: "tool", toolCallRole: "spawn" })).toEqual(child)
    expect(ports.subagents).toHaveLength(1)
    expect(ports.subagents[0]?.revision).toBe(2)
  })

  test("a new request broker reads completed answers without retaining process-lifetime state", async () => {
    const { ports, owner, turn } = setup()
    const waiting = turn.ask(permission("completed-after-restart"))
    await tick()
    await owner.broker.answer("completed-after-restart", { kind: "permission", decision: "allow_once" }, { sessionId: "s1" })
    await waiting
    const restarted = createRequestBroker(ports)
    expect(await restarted.broker.answer("completed-after-restart", { kind: "rejected" }, { sessionId: "s1" })).toMatchObject({ refusal: "duplicate" })
    expect(await restarted.broker.answer("never-asked", { kind: "rejected" }, { sessionId: "s1" })).toMatchObject({ refusal: "stale" })
  })
})

describe("broker review regressions", () => {
  test("F3 identical native ids coexist in separate sessions", async () => {
    const { ports, owner, turn } = setup()
    const other = { ...authority, sessionId: "s2", turnId: "t2" }
    ports.current.set("s2", other)
    const secondTurn = createTurnBroker(owner, { authority: other, origin, signal: new AbortController().signal })
    const first = turn.ask(question("native"))
    const secondRequest = question("native")
    secondRequest.question.sessionID = "s2"
    const second = secondTurn.ask(secondRequest)
    await tick()
    expect(owner.broker.list({ sessionId: "s1" })).toHaveLength(1)
    expect(owner.broker.list({ sessionId: "s2" })).toHaveLength(1)
    expect(await owner.broker.answer("native", { kind: "answers", answers: [[]] }, { sessionId: "s2" })).toMatchObject({ ok: true })
    expect(await second).toEqual({ kind: "answers", answers: [[]] })
    expect(await owner.broker.answer("native", { kind: "rejected" }, { sessionId: "s1" })).toMatchObject({ ok: true })
    expect(await first).toEqual({ kind: "rejected" })
  })

  test("F5 failed grant write records neither answer nor grant", async () => {
    const { ports, owner, turn } = setup()
    const waiting = turn.ask(permission("atomic", "run"))
    await tick()
    ports.failGrant = true
    expect(await owner.broker.answer("atomic", { kind: "permission", decision: "allow_always" }, { sessionId: "s1" })).toMatchObject({ refusal: "persistence" })
    expect(ports.saved).toHaveLength(0)
    expect(ports.states.get("s1")?.brokerGrants).toBeUndefined()
    ports.failGrant = false
    await owner.broker.answer("atomic", { kind: "rejected" }, { sessionId: "s1" })
    expect(await waiting).toEqual({ kind: "rejected" })
  })

  test("F6 grant does not cross a harness switch", async () => {
    const { ports, owner, turn } = setup()
    const first = turn.ask(permission("grant-one", "same"))
    await tick()
    await owner.broker.answer("grant-one", { kind: "permission", decision: "allow_always" }, { sessionId: "s1" })
    await first
    expect(ports.states.get("s1")?.brokerGrants).toEqual([JSON.stringify(["c1", "same"])])
    const switched = { ...authority, connectionId: "c2", turnId: "t2" }
    ports.current.set("s1", switched)
    const next = createTurnBroker(owner, { authority: switched, origin, signal: new AbortController().signal })
    const waiting = next.ask(permission("grant-two", "same"))
    await tick()
    expect(owner.broker.list({ sessionId: "s1" })).toHaveLength(1)
    await owner.broker.answer("grant-two", { kind: "rejected" }, { sessionId: "s1" })
    await waiting
  })

  test("F8 start must remain starting and elicitation carries connection", async () => {
    const { ports, owner } = setup()
    const start: AgentSessionStartBinding = { sessionId: "s1", operationId: "op", workspaceId: "w1", connectionId: "c1", directory: "/work" }
    ports.startBinding = start
    const session = createSessionBroker(owner, { sessionId: "s1", directory: "/work", workspaceId: "w1", connectionId: "c1", operationId: "op", start, origin })
    const waiting = session.ask({ kind: "elicitation", requestId: "start-form", mode: "url", message: "Connect", url: "https://example.com" })
    await tick()
    expect(ports.published[0]).toMatchObject({ properties: { harnessPayload: { connectionId: "c1" } } })
    ports.startStatus = "created"
    expect(await owner.broker.answer("start-form", { kind: "consent", accepted: true }, { start })).toMatchObject({ refusal: "foreign" })
    expect(() => session.ask(question("late-start"))).toThrow("no longer running")
    await owner.requests.cancelStart({ sessionId: "s1", directory: "/work", workspaceId: "w1", connectionId: "c1", operationId: "op", start, origin })
    await waiting
  })

  test("F9 malformed form is refused before publication", async () => {
    const { ports, turn } = setup()
    const asked = turn.ask({ kind: "elicitation", requestId: "bad-schema", mode: "form", message: "Form", schema: { type: "object", properties: { value: { type: "string", pattern: "x".repeat(4097) } } } })
    await tick()
    expect(ports.published).toHaveLength(0)
    await expect(asked).rejects.toMatchObject({ code: "invalid_schema" })
  })

  test("F9 form patterns reach evaluator before asked publication", async () => {
    const { ports, owner, turn } = setup()
    const waiting = turn.ask({ kind: "elicitation", requestId: "pattern-admission", mode: "form", message: "Form", schema: { type: "object", properties: { value: { type: "string", pattern: "^ok$" } } } })
    await tick()
    expect(ports.evaluatedChecks[0]).toEqual([{ field: "value", pattern: "^ok$" }])
    expect(ports.published).toHaveLength(1)
    await owner.broker.answer("pattern-admission", { kind: "rejected" }, { sessionId: "s1" })
    await waiting
  })

  test("F10 pending turn keeps upstream identity", async () => {
    const { owner, turn } = setup()
    const waiting = turn.ask(question("upstream"))
    await tick()
    expect(owner.broker.list({ sessionId: "s1" })[0]?.upstreamSessionId).toBe("up1")
    await owner.broker.answer("upstream", { kind: "rejected" }, { sessionId: "s1" })
    await waiting
  })

  test("F12 explicit option must match decision", async () => {
    const { owner, turn } = setup()
    const waiting = turn.ask(permission("exact", "grant", [{ optionId: "once", kind: "allow_once", name: "Once" }]))
    await tick()
    expect(await owner.broker.answer("exact", { kind: "permission", decision: "allow_always", optionId: "once" }, { sessionId: "s1" }))
      .toMatchObject({ refusal: "unoffered" })
    await owner.broker.answer("exact", { kind: "rejected" }, { sessionId: "s1" })
    await waiting
  })

  test("caller cannot submit terminal answers", async () => {
    const { owner, turn } = setup()
    const waiting = turn.ask(question("terminal"))
    await tick()
    expect(await owner.broker.answer("terminal", { kind: "cancelled" }, { sessionId: "s1" })).toMatchObject({ refusal: "unoffered" })
    expect(await owner.broker.answer("terminal", { kind: "expired" }, { sessionId: "s1" })).toMatchObject({ refusal: "unoffered" })
    await owner.broker.answer("terminal", { kind: "rejected" }, { sessionId: "s1" })
    await waiting
  })

  test("per-request deadlines expire independently", async () => {
    const { ports, owner } = setup()
    const turn = createTurnBroker(owner, { authority, origin, signal: new AbortController().signal, expiresAt: 100 })
    const early = turn.ask({ ...question("early"), expiresAt: 20 })
    const later = turn.ask({ ...question("later"), expiresAt: 80 })
    await tick()
    expect([...ports.timerDelays.values()]).toEqual([10, 70])
    const firstTimer = [...ports.timers.values()][0]
    firstTimer?.()
    expect(await early).toEqual({ kind: "expired" })
    expect(owner.broker.list({ sessionId: "s1" }).map((row) => row.request.requestId)).toEqual(["later"])
    const secondTimer = [...ports.timers.values()][0]
    secondTimer?.()
    expect(await later).toEqual({ kind: "expired" })
  })

  test("F2 list retires durable requests after restart", async () => {
    const { ports } = setup()
    const pending: PendingRequest = { sessionId: "s1", request: question("orphan"), askedAt: 1, upstreamSessionId: "up1" }
    ports.pendingRows.set(JSON.stringify(["s1", "orphan"]), pending)
    const restarted = createRequestBroker(ports)
    expect(restarted.broker.list({ sessionId: "s1" })).toEqual([])
    await tick()
    expect(ports.saved.at(-1)?.answer).toEqual({ kind: "cancelled" })
    expect(await restarted.broker.answer("orphan", { kind: "rejected" }, { sessionId: "s1" })).toMatchObject({ refusal: "stale" })
  })

  test("F4 failed cancellation during validation is retried by the next answer", async () => {
    const { ports, owner, controller, turn } = setup()
    const waiting = turn.ask({ kind: "elicitation", requestId: "cancel-race", mode: "form", message: "Form", schema: { type: "object", properties: { value: { type: "string", pattern: "^ok$" } } } })
    await tick()
    let release!: () => void
    ports.evaluated = new Promise<void>((done) => { release = done })
    const validating = owner.broker.answer("cancel-race", { kind: "form", values: { value: "ok" } }, { sessionId: "s1" })
    await tick()
    ports.failPersist = true
    controller.abort()
    await tick()
    release()
    expect(await validating).toMatchObject({ refusal: "persistence" })
    ports.failPersist = false
    expect(await owner.broker.answer("cancel-race", { kind: "form", values: { value: "ok" } }, { sessionId: "s1" }))
      .toMatchObject({ refusal: "duplicate" })
    expect(await waiting).toEqual({ kind: "cancelled" })
  })

  test("F8 URL consent deduplicates and completion settles it", async () => {
    const { ports, owner, turn } = setup()
    const request = { kind: "elicitation" as const, mode: "url" as const, message: "Connect", url: "https://example.com", elicitationId: "oauth" }
    const first = turn.ask({ ...request, requestId: "url-one" })
    await tick()
    expect(ports.published[0]).toMatchObject({ properties: { harnessPayload: { connectionId: "c1" } } })
    const duplicate = turn.ask({ ...request, requestId: "url-two" })
    await tick()
    expect(owner.broker.list({ sessionId: "s1" })).toHaveLength(1)
    await expect(duplicate).rejects.toThrow("Duplicate outstanding elicitationId")
    await turn.completeElicitation("oauth")
    expect(ports.saved.at(-1)?.answer).toEqual({ kind: "consent", accepted: true })
    expect(await first).toEqual({ kind: "consent", accepted: true })
  })

  test("F11 duplicate permission answer is a refusal during validation", async () => {
    const { owner, turn } = setup()
    const waiting = turn.ask(permission("busy"))
    await tick()
    const first = owner.broker.answer("busy", { kind: "permission", decision: "allow_once" }, { sessionId: "s1" })
    const second = owner.broker.answer("busy", { kind: "permission", decision: "allow_once" }, { sessionId: "s1" })
    expect(await second)
      .toMatchObject({ refusal: "duplicate" })
    await first
    await waiting
  })

  test("F13 grant auto-answer checks abort before persisting", async () => {
    const { ports, controller, turn } = setup()
    ports.states.set("s1", { brokerGrants: ["same", JSON.stringify(["c1", "same"])] })
    ports.onReadPermissionState = () => controller.abort()
    expect(await turn.ask(permission("auto-abort", "same"))).toEqual({ kind: "cancelled" })
    expect(ports.saved.every((row) => row.answer.kind !== "permission")).toBe(true)
  })

  test("cancelling a turn cancels every request even when one cancel fails to persist", async () => {
    const { ports, owner, turn } = setup()
    void turn.ask(question("cancel-a"))
    const second = turn.ask(question("cancel-b"))
    await tick()
    const persist = ports.persistAnswer.bind(ports)
    ports.persistAnswer = async (pending, answer, automatic, grant) => {
      if (pending.request.requestId === "cancel-a") throw new Error("disk full")
      return persist(pending, answer, automatic, grant)
    }
    await expect(owner.requests.cancelTurn(authority)).rejects.toThrow("could not be cancelled")
    expect(await second).toEqual({ kind: "cancelled" })
  })

  test("answer waits for asked publication", async () => {
    const { ports, owner, turn } = setup()
    let release!: () => void
    ports.publishGate = new Promise<void>((done) => { release = done })
    const waiting = turn.ask(question("publish-race"))
    await tick()
    const answer = owner.broker.answer("publish-race", { kind: "rejected" }, { sessionId: "s1" })
    await tick()
    expect(ports.saved).toHaveLength(0)
    release()
    expect(await answer).toMatchObject({ ok: true })
    expect(await waiting).toEqual({ kind: "rejected" })
  })

  test("start factory checks connection and operation", () => {
    const { owner } = setup()
    const start: AgentSessionStartBinding = { sessionId: "s1", operationId: "op", workspaceId: "w1", connectionId: "c1", directory: "/work" }
    const context = { sessionId: "s1", directory: "/work", workspaceId: "w1", connectionId: "c1", operationId: "op", start, origin }
    expect(() => createSessionBroker(owner, { ...context, connectionId: "wrong" })).toThrow("does not match")
    expect(() => createSessionBroker(owner, { ...context, operationId: "wrong" })).toThrow("does not match")
  })
})
