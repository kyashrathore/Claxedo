import { randomUUID } from "node:crypto"
import {
  validateElicitationResponse, elicitationPatternChecks, ElicitationValidationError,
  type ElicitationPatternEvaluator,
  type AgentElicitation, type AgentExecutionBinding, type AgentSessionStartBinding, type AgentQuestion, type ElicitationContent,
} from "@claxedo/agent-runtime-contract"
import { questionAsked, type CompatEvent } from "../../compat-events"
import { mcpElicitationQuestion } from "../shared/mcp-elicitation"
import { SessionQuestionInteractions } from "../shared/sdk-runtime-interactions"
import type { AgentRuntimeStoreWithRecovery } from "../shared/runtime-store"

import { readAcpElicitation } from "./elicitation-request"
import { createElicitationPatternEvaluator } from "./pattern-validation"

export type AcpElicitationResponse = { action: "accept" | "decline" | "cancel"; content?: ElicitationContent }
type Scope = { sessionId: string; directory: string; agentName: string } & ({ agentSessionId: string; start?: never } | { agentSessionId?: never; start: AgentSessionStartBinding })
type Pending = Scope & { request: AgentQuestion; elicitation: AgentElicitation; resolve: (response: AcpElicitationResponse) => void; cleanup: () => void; validating?: AbortController }
// Several adapters can share a durable store. Stale cleanup must ask every
// live connection owner before retiring a row, not just the polling adapter.
const liveOwners = new WeakMap<AgentRuntimeStoreWithRecovery, Set<AcpElicitationInteractions>>()
export function hasLiveAcpElicitation(store: AgentRuntimeStoreWithRecovery, id: string) {
  return [...(liveOwners.get(store) ?? [])].some((owner) => owner.owns(id))
}

/** The one field of a single-answer form response; `undefined` for every other shape. */
function soleAnswer(answers: string[][]) {
  const [only] = answers
  return answers.length === 1 && only?.length === 1 ? only[0] : undefined
}

/** Live ACP resolvers are connection-owned; only the question data is durable. */
export class AcpElicitationInteractions {
  private readonly questionOwner: SessionQuestionInteractions<Pending>
  private readonly pending: Map<string, Pending>
  private readonly urls = new Set<string>()
  private readonly admissions = new Set<AbortController>()
  constructor(private readonly store: AgentRuntimeStoreWithRecovery, private readonly publish: (directory: string, event: CompatEvent) => void, private readonly evaluatePatterns: ElicitationPatternEvaluator = createElicitationPatternEvaluator()) {
    this.questionOwner = new SessionQuestionInteractions((pending, event) => this.commit(pending, event))
    this.pending = this.questionOwner.pending
    const owners = liveOwners.get(store) ?? new Set<AcpElicitationInteractions>()
    owners.add(this)
    liveOwners.set(store, owners)
  }

  create(input: Scope & { params: unknown; signal?: AbortSignal }): Promise<AcpElicitationResponse> {
    const elicitation = readAcpElicitation(input.params, input.agentName)
    if (elicitation.mode === "url" && this.urls.has(elicitation.elicitationId)) throw new Error("Duplicate outstanding elicitationId")
    if (elicitation.mode === "form") {
      const checks = elicitationPatternChecks(elicitation.requestedSchema)
      if (checks.length) {
        const controller = new AbortController()
        this.admissions.add(controller)
        const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal
        return this.evaluatePatterns(checks, signal).then(() => this.present({ ...input, signal }, elicitation)).finally(() => this.admissions.delete(controller))
      }
    }
    return this.present(input, elicitation)
  }

  private present(input: Scope & { signal?: AbortSignal }, elicitation: AgentElicitation): Promise<AcpElicitationResponse> {
    if (input.signal?.aborted) return Promise.resolve({ action: "cancel" })
    const request: AgentQuestion = {
      id: `acp-elicitation-${randomUUID()}`, sessionID: input.sessionId,
      questions: [mcpElicitationQuestion({ ...elicitation, serverName: input.agentName })],
      harnessPayload: { acpHarness: input.agentName },
    }
    return new Promise((resolve, reject) => {
      const abort = () => this.finish(request.id, { action: "cancel" }, [])
      const cleanup = () => input.signal?.removeEventListener("abort", abort)
      const pending: Pending = { ...input, request, elicitation, resolve, cleanup }
      try {
        this.pending.set(request.id, pending)
        if (elicitation.mode === "url") this.urls.add(elicitation.elicitationId)
        this.commit(pending, questionAsked(request))
        input.signal?.addEventListener("abort", abort, { once: true })
        if (input.signal?.aborted) abort()
      } catch (error) {
        cleanup(); this.pending.delete(request.id)
        if (elicitation.mode === "url") this.urls.delete(elicitation.elicitationId)
        reject(error)
      }
    })
  }

  list(directory: string) { return this.store.listQuestions(directory).filter((row) => this.pending.has(row.id)) }
  owns(id: string) { return this.pending.has(id) }

  reply(binding: AgentExecutionBinding, id: string, answers: string[][]) {
    const pending = this.owned(binding, id)
    return this.respond(pending, id, answers)
  }

  private async respond(pending: Pending, id: string, answers: string[][]) {
    if (answers.length === 0) return this.finish(id, { action: "cancel" }, answers)
    const sole = soleAnswer(answers)
    if (pending.elicitation.mode === "url") {
      if (sole === undefined || sole !== pending.request.questions[0]?.options[0]?.label) throw new ElicitationValidationError("invalid_answer", "URL elicitation requires explicit consent")
      return this.finish(id, { action: "accept" }, answers)
    }
    if (sole === undefined) throw new ElicitationValidationError("invalid_answer", "Elicitation requires one structured form response")
    let content: unknown
    try { content = JSON.parse(sole) } catch { throw new ElicitationValidationError("invalid_answer", "Elicitation response must be a JSON object") }
    if (pending.validating) throw new ElicitationValidationError("validation_busy", "This answer is already being validated")
    const controller = new AbortController()
    pending.validating = controller
    try {
      const validated = await validateElicitationResponse(pending.elicitation.requestedSchema, content, this.evaluatePatterns, controller.signal)
      if (this.pending.get(id) !== pending || controller.signal.aborted) throw new ElicitationValidationError("validation_cancelled", "Question is no longer connected to its agent")
      return this.finish(id, { action: "accept", content: validated }, answers)
    } finally {
      if (pending.validating === controller) pending.validating = undefined
    }
  }

  reject(binding: AgentExecutionBinding, id: string) {
    this.owned(binding, id)
    return this.finish(id, { action: "decline" })
  }

  replyStart(start: AgentSessionStartBinding, id: string, answers: string[][]) {
    return this.respond(this.ownedStart(start, id), id, answers)
  }
  rejectStart(start: AgentSessionStartBinding, id: string) {
    this.ownedStart(start, id)
    this.finish(id, { action: "decline" })
  }
  private ownedStart(start: AgentSessionStartBinding, id: string) {
    const pending = this.pending.get(id)
    const owner = pending?.start
    if (!pending || !owner) throw new Error("This startup question is no longer connected to its agent")
    if (owner.sessionId !== start.sessionId || owner.operationId !== start.operationId || owner.workspaceId !== start.workspaceId
      || owner.connectionId !== start.connectionId || owner.directory !== start.directory) throw new Error("Question does not belong to this session start")
    return pending
  }

  cancelSession(agentSessionId: string) {
    for (const [id, pending] of this.pending) if (pending.agentSessionId === agentSessionId) this.finish(id, { action: "cancel" }, [])
  }
  dispose() {
    for (const admission of this.admissions) admission.abort()
    for (const id of this.pending.keys()) this.finish(id, { action: "cancel" }, [])
    this.urls.clear()
    liveOwners.get(this.store)?.delete(this)
  }
  complete(elicitationId: string) { this.urls.delete(elicitationId) }

  private owned(binding: AgentExecutionBinding, id: string) {
    const pending = this.pending.get(id)
    if (!pending) throw new Error("This question is no longer connected to its agent")
    if (pending.start || binding.sessionId !== pending.sessionId || binding.upstreamSessionId !== pending.agentSessionId || binding.directory !== pending.directory) throw new Error("Question does not belong to this session")
    return pending
  }
  private commit(pending: Scope, payload: CompatEvent) {
    const committed = this.store.appendEvent({ sessionId: pending.sessionId, ...(pending.agentSessionId ? { agentSessionId: pending.agentSessionId } : {}), payload,
      source: { dir: "out", method: "elicitation/create" } })
    this.publish(pending.directory, committed.payload)
    return committed.payload
  }
  private finish(id: string, response: AcpElicitationResponse, answers?: string[][]) {
    return this.questionOwner.settle(id, answers, (pending) => {
      pending.validating?.abort()
      pending.cleanup()
      if (pending.elicitation.mode === "url" && response.action !== "accept") this.urls.delete(pending.elicitation.elicitationId)
      pending.resolve(response)
    })
  }
}
