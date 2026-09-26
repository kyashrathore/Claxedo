import type {
  AnswerResult,
  PendingRequest,
  RequestAnswer,
  RequestBroker,
  RequestScope,
  TurnRequest,
} from "../../contract/broker"
import type { BrokerPorts, SessionBrokerContext, TurnBrokerContext } from "../ports"
import { grantToSave } from "../grants"
import { optionMatchesDecision, substitutePermissionOption } from "../options"
import { pendingRequest, requestOwnerIsCurrent, requestTargetMatchesOwner, requestRefusal, sameTurnAuthority, type RequestAuthority } from "./authority"
import { OrphanRetirement } from "./orphan-retirement"
import { preflight } from "./preflight"
import { publishAsked } from "./publication"
import { requestKey } from "./request-key"
import { UrlConsentAdmissions } from "./url-consent"
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
  private readonly asking = new Set<string>()
  private readonly urlConsents = new UrlConsentAdmissions()
  private readonly orphans: OrphanRetirement
  constructor(private readonly ports: BrokerPorts) {
    this.orphans = new OrphanRetirement(ports)
  }

  list(scope: RequestScope): readonly PendingRequest[] {
    this.orphans.retire(scope, (key) => this.entries.has(key) || this.asking.has(key))
    for (const entry of this.entries.values()) {
      if (!requestOwnerIsCurrent(this.ports, entry.authority)) void this.terminate(entry, "cancelled")
        .catch((error: unknown) => this.ports.reportOwnerFailure(entry.pending.sessionId, error))
    }
    return [...this.entries.values()]
      .filter((entry) => entry.phase === "asked" || entry.phase === "validating" || entry.phase === "committing")
      .filter((entry) => requestOwnerIsCurrent(this.ports, entry.authority))
      .filter((entry) => "sessionId" in scope
        ? entry.pending.sessionId === scope.sessionId
        : entry.authority.value.directory === scope.directory)
      .map((entry) => entry.pending)
  }

  askTurn(context: TurnBrokerContext, request: TurnRequest, options?: { signal?: AbortSignal }): Promise<RequestAnswer> {
    const current = this.ports.currentTurnAuthority(context.authority.sessionId)
    const authority = current && sameTurnAuthority(current, context.authority) ? current : context.authority
    const signal = options?.signal ? AbortSignal.any([context.signal, options.signal]) : context.signal
    return this.ask({ kind: "turn", value: authority }, request, request.expiresAt ?? context.expiresAt, signal)
  }

  askStart(context: SessionBrokerContext, request: TurnRequest, options?: { signal?: AbortSignal }): Promise<RequestAnswer> {
    if (!context.start) throw new Error("Session ask requires a start binding")
    const prior = this.ports.readAnswer(context.sessionId, request.requestId)
    if (prior) return Promise.resolve(prior)
    if (options?.signal?.aborted) return this.saveCancelled({ kind: "start", value: context.start }, request)
    if (!requestTargetMatchesOwner(this.ports, { kind: "start", value: context.start }, { start: context.start })) throw new Error("Session start is no longer running")
    return this.ask({ kind: "start", value: context.start }, request, request.expiresAt ?? context.expiresAt, options?.signal)
  }

  private async saveCancelled(authority: RequestAuthority, request: TurnRequest): Promise<RequestAnswer> {
    const answer = { kind: "cancelled" } as const
    await this.ports.persistAnswer(pendingRequest(this.ports, authority, request), answer, false)
    return answer
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
    if (signal?.aborted) return this.saveCancelled(authority, request)
    const sessionId = authority.value.sessionId
    const key = requestKey(sessionId, request.requestId)
    if (this.entries.has(key) || this.asking.has(key)) throw new Error(`Request ${request.requestId} is already registered`)
    this.asking.add(key)
    try {
      await this.orphans.settled(key)
      const prior = this.ports.readAnswer(sessionId, request.requestId)
      if (prior) return prior
      if (!requestOwnerIsCurrent(this.ports, authority)) return this.saveCancelled(authority, request)
      if (request.kind === "elicitation" && request.mode === "form") {
        try { await validateRequest(this.ports, request, signal) }
        catch (error) {
          if (signal?.aborted) return this.saveCancelled(authority, request)
          throw error
        }
      }
      if (signal?.aborted) return this.saveCancelled(authority, request)
      if (!requestOwnerIsCurrent(this.ports, authority)) return this.saveCancelled(authority, request)
      const immediate = await preflight(this.ports, authority, request, expiresAt, signal)
      if (immediate) return immediate
      if (!requestOwnerIsCurrent(this.ports, authority)) return this.saveCancelled(authority, request)
      return await this.register(authority, request, key, expiresAt, signal)
    } finally {
      this.asking.delete(key)
    }
  }

  private async register(
    authority: RequestAuthority,
    request: TurnRequest,
    key: string,
    expiresAt?: number,
    signal?: AbortSignal,
  ): Promise<RequestAnswer> {
    const sessionId = authority.value.sessionId
    const pending = pendingRequest(this.ports, authority, request)
    let resolve!: (answer: RequestAnswer) => void
    const response = new Promise<RequestAnswer>((done) => { resolve = done })
    const entry: Entry = { pending, authority, phase: "asked", resolve }
    this.entries.set(key, entry)
    try {
      entry.published = publishAsked(this.ports, pending, authority.value.connectionId)
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
    const entry = this.entries.get(requestKey(sessionId, requestId))
    if (!entry) {
      if ([...this.entries.values()].some((candidate) => candidate.pending.request.requestId === requestId)) return requestRefusal("foreign")
      const prior = this.ports.readAnswer(sessionId, requestId)
      return requestRefusal(prior && prior.kind !== "cancelled" && prior.kind !== "expired" ? "duplicate" : "stale")
    }
    if (!requestOwnerIsCurrent(this.ports, entry.authority)) {
      try { await this.terminate(entry, "cancelled") } catch { return requestRefusal("persistence") }
      return requestRefusal("foreign")
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
    this.entries.delete(requestKey(entry.pending.sessionId, entry.pending.request.requestId))
    entry.resolve(answer)
  }

  async completeElicitation(sessionId: string, connectionId: string, elicitationId: string): Promise<void> {
    this.urlConsents.complete(sessionId, connectionId, elicitationId)
  }

  closeSession(sessionId: string): void {
    this.urlConsents.clearSession(sessionId)
  }

  private async retryTermination(entry: Entry): Promise<AnswerResult> {
    try { await this.finishTermination(entry); return requestRefusal("duplicate") }
    catch { return requestRefusal("persistence") }
  }

}
