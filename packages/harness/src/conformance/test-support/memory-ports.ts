import { UnknownHostSubagentKeyError, type AgentSessionStartBinding, type SubagentObservation } from "@claxedo/agent-runtime-contract"
import { errorMessage } from "@claxedo/helpers"
import type { AgentRuntimeEvent, SubagentUpdatedEvent } from "@claxedo/agent-event-runtime/contracts"
import type { PendingRequest, RequestAnswer } from "../../contract/broker"
import type { BrokerEvent, BrokerPorts, SubagentAdmissionStore, TurnAuthority } from "../../broker/ports"

export const origin = { actor: { kind: "machine-owner" as const }, via: "loopback" as const, reissued: false }
export const authority: TurnAuthority = {
  sessionId: "s1", workspaceId: "w1", directory: "/work", connectionId: "c1",
  upstreamSessionId: "up1", ownerGeneration: "g1", turnId: "t1",
}

export class MemoryPorts implements BrokerPorts {
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
  directories = new Map<string, string>([["s1", "/work"]])
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
    const key = JSON.stringify([pending.sessionId, pending.request.requestId])
    if (this.answers.has(key)) return []
    if (this.failPersist) throw new Error("disk unavailable")
    if (grantKey && this.failGrant) throw new Error("grant write unavailable")
    if (grantKey) {
      const state = this.states.get(pending.sessionId) ?? {}
      const grants = (state.brokerGrants as string[] | undefined) ?? []
      this.states.set(pending.sessionId, { ...state, brokerGrants: [...new Set([...grants, grantKey])] })
    }
    this.saved.push({ pending, answer, automatic })
    this.answers.set(key, answer)
    this.pendingRows.delete(key)
    return []
  }
  readAnswer(sessionId: string, requestId: string) { return this.answers.get(JSON.stringify([sessionId, requestId])) }
  async publish(event: BrokerEvent) {
    await this.publishGate
    this.published.push(event)
  }
  readPending(scope: { sessionId: string } | { directory: string }) {
    return [...this.pendingRows.values()].filter((row) => "sessionId" in scope ? row.sessionId === scope.sessionId :
      this.directories.get(row.sessionId) === scope.directory)
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
  providerTurn?: AbortController
  cancelProviderTurn() { this.providerTurn?.abort() }
  async admitProviderTurn(_sessionId: string, _input: unknown, run: (id: string, signal: AbortSignal) => Promise<void>) {
    const controller = new AbortController()
    this.providerTurn = controller
    const settled = Promise.resolve().then(() => run("t1", controller.signal)).then(
      () => controller.signal.aborted ? { state: "cancelled" as const } : { state: "completed" as const },
      (error: unknown) => controller.signal.aborted ? { state: "cancelled" as const } : { state: "failed" as const, error: errorMessage(error) },
    )
    return { admitted: true as const, turnId: "t1", settled }
  }
  async drainProviderEvent(_sessionId: string, _turnId: string, event: unknown) { this.drained.push(event) }
  meterUsage(_usage: unknown) {}
  sessionEvents: { sessionId: string; event: unknown }[] = []
  async publishSessionEvent(sessionId: string, event: unknown) { this.sessionEvents.push({ sessionId, event }) }
  async admitChildSession(_sessionId: string, childSessionId: string, _observation: SubagentObservation) {
    return this.children.get(childSessionId) ?? { sessionId: childSessionId, assistantMessageId: "assistant", created: 10 }
  }
  async publishSubagent(_sessionId: string, event: SubagentUpdatedEvent) { this.subagents.push(event) }
  async publishSubagentDiagnostic(_sessionId: string, diagnostic: unknown) {
    this.diagnostics.push(diagnostic)
  }
  async rebind(sessionId: string, upstream: string) {
    const current = this.current.get(sessionId)
    if (current) this.current.set(sessionId, { ...current, upstreamSessionId: upstream })
  }
  async persistHandoff(_sessionId: string, _context: unknown) {}
  config(_sessionId: string): never { throw new Error("unused") }
  reportOwnerFailure(_sessionId: string, error: unknown) { this.failures.push(error) }
}
