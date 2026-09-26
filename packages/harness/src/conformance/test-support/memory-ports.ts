import type { AgentSessionStartBinding, RuntimeGoalSnapshot, SessionConfig, SubagentObservation } from "@claxedo/agent-runtime-contract"
import { errorMessage } from "@claxedo/helpers"
import type { AgentRuntimeEvent, SubagentUpdatedEvent } from "@claxedo/agent-event-runtime/contracts"
import type { PendingRequest, ProviderTurnInput, ProviderTurnResult, RequestAnswer } from "../../contract/broker"
import type { HarnessBinding, TurnRef } from "../../contract/session"
import type { BrokerEvent, BrokerPorts, SubagentAdmissionStore, TurnAuthority } from "../../broker/ports"
import { createMemorySubagentAdmissionStore } from "../../broker/subagents/admission"

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
  readonly subagentAdmissionStore: SubagentAdmissionStore = createMemorySubagentAdmissionStore()
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
  async publish(event: BrokerEvent, pending?: PendingRequest) {
    await this.publishGate
    this.published.push(event)
    if (pending) this.pendingRows.set(JSON.stringify([pending.sessionId, pending.request.requestId]), pending)
  }
  readPending(scope: { sessionId: string } | { directory: string }): readonly PendingRequest[] {
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
  readGoal(_sessionId: string): RuntimeGoalSnapshot | null { return null }
  async publishGoal(_sessionId: string, _snapshot: RuntimeGoalSnapshot | null) {}
  providerTurn?: AbortController
  nextProviderTurn = 0
  cancelProviderTurn() { this.providerTurn?.abort() }
  async admitProviderTurn(_sessionId: string, _input: ProviderTurnInput, run: (turn: TurnRef, signal: AbortSignal) => Promise<void>): Promise<ProviderTurnResult> {
    const controller = new AbortController()
    this.providerTurn = controller
    const turnId = `provider-${++this.nextProviderTurn}`
    const turn: TurnRef = { turnId, assistantMessageId: turnId }
    const authority = this.current.get(_sessionId)
    if (authority) this.current.set(_sessionId, { ...authority, turnId })
    const settled = Promise.resolve().then(() => run(turn, controller.signal)).then(
      () => controller.signal.aborted ? { state: "cancelled" as const } : { state: "completed" as const },
      (error: unknown) => controller.signal.aborted ? { state: "cancelled" as const } : { state: "failed" as const, error: errorMessage(error) },
    )
    return { admitted: true as const, turn, settled }
  }
  async drainProviderEvent(_sessionId: string, _turn: TurnRef, event: unknown) { this.drained.push(event) }
  meterUsage(_usage: unknown) {}
  sessionEvents: { sessionId: string; event: unknown }[] = []
  async publishSessionEvent(sessionId: string, event: unknown) { this.sessionEvents.push({ sessionId, event }) }
  async admitChildSession(_sessionId: string, childSessionId: string, _observation: SubagentObservation) {
    return this.children.get(childSessionId) ?? { sessionId: childSessionId, assistantMessageId: "assistant", created: 10 }
  }
  bindChildCorrelation(_sessionId: string, _correlationKey: string, _childSessionId: string) {}
  async publishSubagent(_sessionId: string, event: SubagentUpdatedEvent) { this.subagents.push(event) }
  async publishSubagentDiagnostic(_sessionId: string, diagnostic: unknown) {
    this.diagnostics.push(diagnostic)
  }
  bindings = new Map<string, HarnessBinding>()
  async rebind(sessionId: string, upstream: string): Promise<HarnessBinding> {
    const current = this.current.get(sessionId)
    if (current) this.current.set(sessionId, { ...current, upstreamSessionId: upstream })
    const identity = current ?? this.startBinding
    if (!identity || identity.sessionId !== sessionId) throw new Error(`Session ${sessionId} has no binding to rebind`)
    const binding: HarnessBinding = { sessionId, workspaceId: identity.workspaceId, directory: identity.directory,
      connectionId: identity.connectionId, upstreamSessionId: upstream }
    this.bindings.set(sessionId, binding)
    return binding
  }
  async persistHandoff(_sessionId: string, _context: unknown) {}
  config(_sessionId: string): SessionConfig { throw new Error("unused") }
  reportOwnerFailure(_sessionId: string, error: unknown) { this.failures.push(error) }
}
