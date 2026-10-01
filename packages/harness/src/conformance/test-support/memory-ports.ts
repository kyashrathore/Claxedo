import type { AgentSessionStartBinding, RuntimeGoalSnapshot, SessionConfig, SubagentObservation } from "@claxedo/agent-runtime-contract"
import { errorMessage } from "@claxedo/helpers"
import type { AgentRuntimeEvent, SubagentUpdatedEvent } from "@claxedo/agent-runtime-contract"
import type { PendingRequest, ProviderTurnInput, ProviderTurnResult, ProviderTurnSettlement, RequestAnswer } from "../../contract/broker"
import type { HarnessBinding, RoutedEvent, TurnRef } from "../../contract/session"
import type { BrokerEvent, BrokerPorts, ChildRoute, RequestGrant, SessionAuthority, SubagentAdmissionStore, TurnAuthority } from "../../broker/ports"
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
  sessionAuthorities = new Map<string, SessionAuthority>([["s1", { sessionId: "s1", workspaceId: "w1", directory: "/work", connectionId: "c1",
    upstreamSessionId: "up1", ownerGeneration: "g1" }]])
  sessionAuthority(sessionId: string) { return this.sessionAuthorities.get(sessionId) }
  openChildTurns = new Set<string>()
  turnOpen(sessionId: string, turnId: string) {
    return this.openChildTurns.has(JSON.stringify([sessionId, turnId])) && !this.finishedChildren.has(sessionId)
  }
  async persistAnswer(pending: PendingRequest, answer: RequestAnswer, automatic: boolean, grant?: RequestGrant): Promise<readonly AgentRuntimeEvent[]> {
    const key = JSON.stringify([pending.sessionId, pending.request.requestId])
    if (this.answers.has(key)) return []
    if (this.failPersist) throw new Error("disk unavailable")
    if (grant && this.failGrant) throw new Error("grant write unavailable")
    if (grant) {
      const state = this.states.get(grant.sessionId) ?? {}
      const grants = (state.brokerGrants as string[] | undefined) ?? []
      this.states.set(grant.sessionId, { ...state, brokerGrants: [...new Set([...grants, grant.key])] })
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
  providerInputs: ProviderTurnInput[] = []
  async admitProviderTurn(_sessionId: string, input: ProviderTurnInput, run: (turn: TurnRef, signal: AbortSignal) => Promise<void>): Promise<ProviderTurnResult> {
    this.providerInputs.push(input)
    const controller = new AbortController()
    this.providerTurn = controller
    const turnId = `provider-${++this.nextProviderTurn}`
    const turn: TurnRef = { turnId, assistantMessageId: turnId }
    const authority = this.current.get(_sessionId)
    if (authority) this.current.set(_sessionId, { ...authority, turnId })
    const settled = Promise.resolve().then(() => run(turn, controller.signal)).then(
      (): ProviderTurnSettlement => {
        const terminal = this.terminals.get(turnId)
        if (controller.signal.aborted) return { state: "cancelled" }
        if (!terminal) return { state: "failed", error: "Harness stream ended without a terminal event" }
        return terminal.type === "error" ? { state: "failed", error: terminal.error } : { state: "completed" }
      },
      (error: unknown): ProviderTurnSettlement => controller.signal.aborted ? { state: "cancelled" } : { state: "failed", error: errorMessage(error) },
    )
    return { admitted: true as const, turn, settled }
  }
  private readonly terminals = new Map<string, Extract<RoutedEvent["event"], { type: "finish" | "error" }>>()
  async drainProviderEvent(_sessionId: string, turn: TurnRef, event: RoutedEvent) {
    this.drained.push(event)
    if (event.route?.kind !== "child" && (event.event.type === "finish" || event.event.type === "error")) this.terminals.set(turn.turnId, event.event)
  }
  childEvents: { sessionId: string; event: RoutedEvent }[] = []
  async drainChildEvent(sessionId: string, event: RoutedEvent) { this.childEvents.push({ sessionId, event }) }
  meterUsage(_usage: unknown) {}
  sessionEvents: { sessionId: string; event: unknown }[] = []
  async publishSessionEvent(sessionId: string, event: unknown) { this.sessionEvents.push({ sessionId, event }) }
  async admitChildSession(_sessionId: string, childSessionId: string, _observation: SubagentObservation) {
    return this.children.get(childSessionId) ?? { sessionId: childSessionId, assistantMessageId: "assistant", created: 10 }
  }
  childBindings = new Map<string, string>()
  finishedChildren = new Set<string>()
  bindChildCorrelation(sessionId: string, correlationKey: string, childSessionId: string) {
    this.childBindings.set(JSON.stringify([sessionId, correlationKey]), childSessionId)
  }
  childRoute(sessionId: string, correlationKey: string): ChildRoute {
    const childSessionId = this.childBindings.get(JSON.stringify([sessionId, correlationKey]))
    if (!childSessionId) return { kind: "unbound" }
    const assistantMessageId = this.children.get(childSessionId)?.assistantMessageId ?? "assistant"
    return { kind: this.finishedChildren.has(childSessionId) ? "finished" : "bound", childSessionId, assistantMessageId }
  }
  finishChildTurn(sessionId: string, correlationKey: string) {
    const route = this.childRoute(sessionId, correlationKey)
    if (route.kind === "unbound") throw new Error(`No child bound to ${correlationKey}`)
    this.finishedChildren.add(route.childSessionId)
  }
  startChildTurn(sessionId: string, correlationKey: string) {
    const route = this.childRoute(sessionId, correlationKey)
    if (route.kind !== "bound") throw new Error(`No running child bound to ${correlationKey}`)
    this.openChildTurns.add(JSON.stringify([route.childSessionId, route.assistantMessageId]))
  }
  reopenChildTurn(sessionId: string, correlationKey: string) {
    const route = this.childRoute(sessionId, correlationKey)
    if (route.kind === "unbound") throw new Error(`No child bound to ${correlationKey}`)
    this.children.set(route.childSessionId, { sessionId: route.childSessionId, assistantMessageId: `${route.assistantMessageId}-reopened`, created: 10 })
    this.finishedChildren.delete(route.childSessionId)
    this.startChildTurn(sessionId, correlationKey)
  }
  rebindConnection(sessionId: string, connectionId: string) {
    const current = this.sessionAuthorities.get(sessionId)
    if (!current) throw new Error(`Session ${sessionId} has no binding`)
    this.sessionAuthorities.set(sessionId, { ...current, connectionId })
  }
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
  config(_sessionId: string): SessionConfig { throw new Error("unused") }
  reportOwnerFailure(_sessionId: string, error: unknown) { this.failures.push(error) }
}
