import type {
  AnswerResult,
  PendingRequest,
  RequestAnswer,
  RequestBroker,
  RequestScope,
  TurnRequest,
} from "../../contract/broker"
import type { BrokerPorts, SessionBrokerContext, TurnBrokerContext } from "../ports"
import { grantToSave, hasGrant } from "../grants"
import { optionMatchesDecision, substitutePermissionOption } from "../options"
import { requestTargetMatchesOwner, requestRefusal, type RequestAuthority } from "./authority"
import { elicitationQuestion } from "./elicitation-question"
import { OrphanRetirement } from "./orphan-retirement"
import { findUrlConsent, UrlConsentAdmissions } from "./url-consent"
import { validateAnswer, validateRequest } from "./validation"
import { ElicitationValidationError } from "@claxedo/agent-runtime-contract"

type Entry = {
  pending: PendingRequest
  authority: RequestAuthority
  phase: "asked" | "validating" | "committing" | "answered" | "cancelled" | "expired"
  resolve(answer: RequestAnswer): void
  expiry?: unknown
  validating?: AbortController
  cancelRequested?: "cancelled" | "expired"
  published?: Promise<void>
  termination?: Promise<void>
}

export class RequestTable implements RequestBroker {
  private readonly entries = new Map<string, Entry>()
  private readonly urlConsents = new UrlConsentAdmissions()
  private readonly orphans: OrphanRetirement
  constructor(private readonly ports: BrokerPorts) {
    this.orphans = new OrphanRetirement(ports)
  }

  list(scope: RequestScope): readonly PendingRequest[] {
    this.orphans.retire(scope, (sessionId, requestId) => this.entries.has(this.key(sessionId, requestId)))
    return [...this.entries.values()]
      .filter((entry) => entry.phase === "asked" || entry.phase === "validating" || entry.phase === "committing")
      .filter((entry) => "sessionId" in scope
        ? entry.pending.sessionId === scope.sessionId
        : entry.authority.value.directory === scope.directory)
      .map((entry) => entry.pending)
  }

  askTurn(context: TurnBrokerContext, request: TurnRequest): Promise<RequestAnswer> {
    return this.ask({ kind: "turn", value: context.authority }, request, request.expiresAt ?? context.expiresAt, context.signal)
  }

  askStart(context: SessionBrokerContext, request: TurnRequest): Promise<RequestAnswer> {
    if (!context.start) throw new Error("Session ask requires a start binding")
    if (!requestTargetMatchesOwner(this.ports, { kind: "start", value: context.start }, { start: context.start })) throw new Error("Session start is no longer running")
    return this.ask({ kind: "start", value: context.start }, request, request.expiresAt ?? context.expiresAt)
  }

  private ask(authority: RequestAuthority, request: TurnRequest, expiresAt?: number, signal?: AbortSignal): Promise<RequestAnswer> {
    return this.urlConsents.admit(authority, request, () => this.askRegistered(authority, request, expiresAt, signal))
  }

  private async askRegistered(
    authority: RequestAuthority,
    request: TurnRequest,
    expiresAt?: number,
    signal?: AbortSignal,
  ): Promise<RequestAnswer> {
    if (request.kind === "elicitation" && request.mode === "form") await validateRequest(this.ports, request, signal)
    const immediate = await this.preflight(authority, request, expiresAt, signal)
    if (immediate) return immediate
    const sessionId = authority.value.sessionId
    const pending = this.pending(authority, request)
    let resolve!: (answer: RequestAnswer) => void
    const response = new Promise<RequestAnswer>((done) => { resolve = done })
    const entry: Entry = { pending, authority, phase: "asked", resolve }
    const key = this.key(sessionId, request.requestId)
    this.entries.set(key, entry)
    try {
      entry.published = this.publishAsked(pending, authority.value.connectionId)
      await entry.published
      if (expiresAt !== undefined) {
        entry.expiry = this.ports.clock.setTimeout(() => {
          void this.terminate(entry, "expired").catch((error: unknown) => this.ports.reportOwnerFailure(sessionId, error))
        }, Math.max(0, expiresAt - this.ports.clock.now()))
      }
      if (signal) this.bindAbort(entry, signal, response)
    } catch (error) {
      this.entries.delete(key)
      throw error
    }
    return response
  }

  private async preflight(
    authority: RequestAuthority, request: TurnRequest, expiresAt?: number, signal?: AbortSignal,
  ): Promise<RequestAnswer | undefined> {
    if (signal?.aborted) return { kind: "cancelled" }
    const sessionId = authority.value.sessionId
    if (this.entries.has(this.key(sessionId, request.requestId)) || this.ports.readAnswer(sessionId, request.requestId)) {
      throw new Error(`Request ${request.requestId} is already registered`)
    }
    if (request.kind === "permission" && request.permission.sessionID !== sessionId) throw new Error("Permission belongs to another session")
    if (request.kind === "question" && request.question.sessionID !== sessionId) throw new Error("Question belongs to another session")
    if (expiresAt !== undefined && expiresAt <= this.ports.clock.now()) {
      const pending = this.pending(authority, request)
      await this.ports.persistAnswer(pending, { kind: "expired" }, false)
      return { kind: "expired" }
    }
    if (request.kind === "permission" && hasGrant(this.ports, sessionId, authority.value.connectionId, request)) {
      const automatic = substitutePermissionOption({ kind: "permission", decision: "allow_always" }, request.options)
      const pending = this.pending(authority, request)
      if (signal?.aborted) {
        await this.ports.persistAnswer(pending, { kind: "cancelled" }, false)
        return { kind: "cancelled" }
      }
      await this.ports.persistAnswer(pending, automatic, true)
      await this.ports.publish({ type: "permission.auto-answered", sessionId, requestId: request.requestId, grantKey: request.grantKey! })
      return automatic
    }
    return undefined
  }

  private bindAbort(entry: Entry, signal: AbortSignal, response: Promise<RequestAnswer>): void {
    const cancel = () => {
      void this.terminate(entry, "cancelled").catch((error: unknown) => this.ports.reportOwnerFailure(entry.pending.sessionId, error))
    }
    signal.addEventListener("abort", cancel, { once: true })
    void response.then(() => signal.removeEventListener("abort", cancel))
    if (signal.aborted) cancel()
  }

  async answer(
    requestId: string,
    answer: RequestAnswer,
    target: Parameters<RequestBroker["answer"]>[2],
  ): Promise<AnswerResult> {
    const sessionId = "sessionId" in target ? target.sessionId : target.start.sessionId
    const entry = this.entries.get(this.key(sessionId, requestId))
    if (!entry) {
      if ([...this.entries.values()].some((candidate) => candidate.pending.request.requestId === requestId)) return requestRefusal("foreign")
      const prior = this.ports.readAnswer(sessionId, requestId)
      return requestRefusal(prior && prior.kind !== "cancelled" && prior.kind !== "expired" ? "duplicate" : "stale")
    }
    if (!requestTargetMatchesOwner(this.ports, entry.authority, target)) return requestRefusal("foreign")
    if (answer.kind === "cancelled" || answer.kind === "expired") return requestRefusal("unoffered")
    try { await entry.published } catch { return requestRefusal("persistence") }
    if (entry.phase === "validating") {
      if (entry.pending.request.kind !== "elicitation" || entry.pending.request.mode !== "form") return requestRefusal("duplicate")
      throw new ElicitationValidationError("validation_busy", "This request is already being validated")
    }
    if (entry.cancelRequested) return this.retryTermination(entry)
    if (entry.phase !== "asked") return requestRefusal("duplicate")
    const selected = this.selectAnswer(entry, answer)
    if (!selected) return requestRefusal("unoffered")
    answer = selected
    entry.phase = "validating"
    const controller = new AbortController()
    entry.validating = controller
    try {
      await validateAnswer(this.ports, entry.pending.request, answer, controller.signal)
    } catch (error) {
      entry.validating = undefined
      if (entry.cancelRequested) return this.retryTermination(entry)
      entry.phase = "asked"
      throw error
    }
    entry.validating = undefined
    if (entry.cancelRequested) return this.retryTermination(entry)
    return this.commitAnswer(entry, answer)
  }

  private selectAnswer(entry: Entry, answer: RequestAnswer): RequestAnswer | undefined {
    if (entry.pending.request.kind !== "permission" || answer.kind !== "permission") return answer
    const options = entry.pending.request.options
    const chosenId = answer.optionId
    if (chosenId !== undefined && !options?.some((option) =>
      option.optionId === chosenId && optionMatchesDecision(answer.decision, option.kind))) return undefined
    return substitutePermissionOption(answer, options)
  }

  private async commitAnswer(entry: Entry, answer: RequestAnswer): Promise<AnswerResult> {
    entry.phase = "committing"
    try {
      const grant = entry.pending.request.kind === "permission" ?
        grantToSave(entry.authority.value.connectionId, entry.pending.request, answer) : undefined
      const events = await this.ports.persistAnswer(entry.pending, answer, false, grant)
      if (entry.cancelRequested) {
        await this.finishTermination(entry)
        return requestRefusal("duplicate")
      }
      this.finish(entry, answer)
      return { ok: true, events }
    } catch (error) {
      this.ports.reportOwnerFailure(entry.pending.sessionId, error)
      if (entry.cancelRequested) await this.finishTermination(entry)
      else entry.phase = "asked"
      return requestRefusal("persistence")
    }
  }

  cancelTurn(authority: TurnBrokerContext["authority"]): Promise<void> {
    return this.cancelAll([...this.entries.values()].filter((entry) =>
      entry.authority.kind === "turn" && entry.authority.value.sessionId === authority.sessionId &&
      entry.authority.value.turnId === authority.turnId &&
      entry.authority.value.ownerGeneration === authority.ownerGeneration))
  }

  cancelStart(context: SessionBrokerContext): Promise<void> {
    return this.cancelAll([...this.entries.values()].filter((entry) =>
      entry.authority.kind === "start" && entry.authority.value.operationId === context.start?.operationId &&
      entry.authority.value.sessionId === context.sessionId))
  }

  private async cancelAll(entries: readonly Entry[]): Promise<void> {
    const results = await Promise.allSettled(entries.map((entry) => this.terminate(entry, "cancelled")))
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, `${failures.length} of ${entries.length} requests could not be cancelled`)
  }

  private async terminate(entry: Entry, kind: "cancelled" | "expired"): Promise<void> {
    if (entry.phase === "answered" || entry.phase === "cancelled" || entry.phase === "expired") return
    entry.cancelRequested = kind
    entry.validating?.abort()
    await entry.published
    if (entry.phase === "committing") return
    await this.finishTermination(entry)
  }

  private async finishTermination(entry: Entry): Promise<void> {
    if (entry.termination) return entry.termination
    if (entry.phase === "cancelled" || entry.phase === "expired") return
    entry.termination = this.persistTermination(entry)
    try { await entry.termination } finally { entry.termination = undefined }
  }

  private async persistTermination(entry: Entry): Promise<void> {
    const kind = entry.cancelRequested!
    entry.phase = "committing"
    try {
      await this.ports.persistAnswer(entry.pending, { kind }, false)
    } catch (error) {
      entry.phase = "asked"
      this.ports.reportOwnerFailure(entry.pending.sessionId, error)
      throw error
    }
    this.finish(entry, { kind })
  }

  private finish(entry: Entry, answer: RequestAnswer): void {
    entry.phase = answer.kind === "cancelled" ? "cancelled" : answer.kind === "expired" ? "expired" : "answered"
    if (entry.expiry !== undefined) this.ports.clock.clearTimeout(entry.expiry)
    this.entries.delete(this.key(entry.pending.sessionId, entry.pending.request.requestId))
    entry.resolve(answer)
  }

  private pending(authority: RequestAuthority, request: TurnRequest): PendingRequest {
    return { sessionId: authority.value.sessionId, request, askedAt: this.ports.clock.now(),
      ...(authority.kind === "turn" ? { upstreamSessionId: authority.value.upstreamSessionId } : {}),
      ...(authority.kind === "start" ? { start: authority.value } : {}) }
  }

  private async publishAsked(pending: PendingRequest, connectionId: string): Promise<void> {
    const request = pending.request
    if (request.kind === "permission") {
      await this.ports.publish({ id: `permission.asked:${this.key(pending.sessionId, request.requestId)}`, type: "permission.asked", properties: request.permission })
    } else if (request.kind === "question") {
      await this.ports.publish({ id: `question.asked:${this.key(pending.sessionId, request.requestId)}`, type: "question.asked", properties: request.question })
    } else {
      await this.ports.publish({ id: `question.asked:${this.key(pending.sessionId, request.requestId)}`, type: "question.asked", properties: elicitationQuestion(pending, connectionId) })
    }
  }

  async completeElicitation(sessionId: string, connectionId: string, elicitationId: string): Promise<void> {
    const entry = findUrlConsent(this.entries.values(), sessionId, connectionId, elicitationId)
    if (!entry) return
    const target = entry.authority.kind === "start" ? { start: entry.authority.value } : { sessionId }
    const result = await this.answer(entry.pending.request.requestId, { kind: "consent", accepted: true }, target)
    if (!result.ok) throw new Error(`Elicitation completion refused: ${result.refusal}`)
  }

  private async retryTermination(entry: Entry): Promise<AnswerResult> {
    try { await this.finishTermination(entry); return requestRefusal("duplicate") }
    catch { return requestRefusal("persistence") }
  }

  private key(sessionId: string, requestId: string): string {
    return JSON.stringify([sessionId, requestId])
  }
}
