import type {
  AnswerResult,
  PendingRequest,
  RequestAnswer,
  RequestBroker,
  RequestReply,
  RequestScope,
  TurnRequest,
} from "../../contract/broker"
import type { BrokerPorts, SessionBrokerContext, TurnBrokerContext } from "../ports"
import { replyAnswer } from "../options"
import { pendingRequest, requestOwnerIsCurrent, requestTargetMatchesOwner, requestRefusal, sameTurnAuthority, type FiledRequest, type RequestAuthority } from "./authority"
import { validateAndCommit } from "./commit"
import { RequestEntries, type RequestEntry } from "./entries"
import { fileTurnRequest } from "./filing"
import { OrphanRetirement } from "./orphan-retirement"
import { preflight } from "./preflight"
import { publishAsked } from "./publication"
import { requestKey } from "./request-key"
import { UrlConsentAdmissions } from "./url-consent"
import { validateRequest } from "./validation"
import { ElicitationValidationError } from "@claxedo/agent-runtime-contract"

export class RequestTable implements RequestBroker {
  private readonly entries: RequestEntries
  private readonly urlConsents = new UrlConsentAdmissions()
  private readonly orphans: OrphanRetirement
  constructor(private readonly ports: BrokerPorts) {
    this.entries = new RequestEntries(ports)
    this.orphans = new OrphanRetirement(ports)
  }

  list(scope: RequestScope): readonly PendingRequest[] {
    this.orphans.retire(scope, (key) => this.entries.has(key))
    for (const entry of this.entries.all()) {
      if (!requestOwnerIsCurrent(this.ports, entry.authority)) void this.entries.terminate(entry, "cancelled")
        .catch((error: unknown) => this.ports.reportOwnerFailure(entry.pending.sessionId, error))
    }
    return this.entries.all()
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
    let filed: FiledRequest
    try { filed = fileTurnRequest(this.ports, authority, request) } catch (error) { return Promise.reject(error) }
    return this.ask({ kind: "turn", value: authority }, filed, request.expiresAt ?? context.expiresAt, signal)
  }

  askStart(context: SessionBrokerContext, request: TurnRequest, options?: { signal?: AbortSignal }): Promise<RequestAnswer> {
    if (!context.start) throw new Error("Session ask requires a start binding")
    const prior = this.ports.readAnswer(context.sessionId, request.requestId)
    if (prior) return Promise.resolve(prior)
    const authority: RequestAuthority = { kind: "start", value: context.start }
    const filed = { sessionId: context.start.sessionId, request }
    if (options?.signal?.aborted) return this.saveCancelled(authority, filed)
    if (!requestTargetMatchesOwner(this.ports, authority, filed.sessionId, { start: context.start })) throw new Error("Session start is no longer running")
    return this.ask(authority, filed, request.expiresAt ?? context.expiresAt, options?.signal)
  }

  private async saveCancelled(authority: RequestAuthority, filed: FiledRequest): Promise<RequestAnswer> {
    const answer = { kind: "cancelled" } as const
    await this.ports.persistAnswer(pendingRequest(this.ports, authority, filed), answer, false)
    return answer
  }

  private ask(authority: RequestAuthority, filed: FiledRequest, expiresAt?: number, signal?: AbortSignal): Promise<RequestAnswer> {
    return this.urlConsents.admit(authority, filed.request, () => this.askRegistered(authority, filed, expiresAt, signal))
  }

  private async askRegistered(
    authority: RequestAuthority,
    filed: FiledRequest,
    expiresAt?: number,
    signal?: AbortSignal,
  ): Promise<RequestAnswer> {
    if (signal?.aborted) return this.saveCancelled(authority, filed)
    const { sessionId, request } = filed
    const key = requestKey(sessionId, request.requestId)
    if (this.entries.has(key)) throw new Error(`Request ${request.requestId} is already registered`)
    this.entries.reserve(key)
    try {
      await this.orphans.settled(key)
      const prior = this.ports.readAnswer(sessionId, request.requestId)
      if (prior) return prior
      if (!requestOwnerIsCurrent(this.ports, authority)) return this.saveCancelled(authority, filed)
      if (request.kind === "elicitation" && request.mode === "form") {
        try { await validateRequest(this.ports, request, signal) }
        catch (error) {
          if (signal?.aborted) return this.saveCancelled(authority, filed)
          throw error
        }
      }
      if (signal?.aborted) return this.saveCancelled(authority, filed)
      if (!requestOwnerIsCurrent(this.ports, authority)) return this.saveCancelled(authority, filed)
      const immediate = await preflight(this.ports, authority, filed, expiresAt, signal)
      if (immediate) return immediate
      if (!requestOwnerIsCurrent(this.ports, authority)) return this.saveCancelled(authority, filed)
      return await this.register(authority, filed, key, expiresAt, signal)
    } finally {
      this.entries.release(key)
    }
  }

  private async register(
    authority: RequestAuthority,
    filed: FiledRequest,
    key: string,
    expiresAt?: number,
    signal?: AbortSignal,
  ): Promise<RequestAnswer> {
    const { sessionId } = filed
    const pending = pendingRequest(this.ports, authority, filed)
    let resolve!: (answer: RequestAnswer) => void
    const response = new Promise<RequestAnswer>((done) => { resolve = done })
    const entry: RequestEntry = { pending, authority, phase: "asked", resolve }
    this.entries.add(key, entry)
    try {
      entry.published = publishAsked(this.ports, pending, authority.value.connectionId)
      await entry.published
      if (expiresAt !== undefined) {
        entry.expiry = this.ports.clock.setTimeout(() => {
          void this.entries.terminate(entry, "expired").catch((error: unknown) => this.ports.reportOwnerFailure(sessionId, error))
        }, Math.max(0, expiresAt - this.ports.clock.now()))
      }
      if (signal) this.bindAbort(entry, signal, response)
    } catch (error) {
      this.entries.remove(key)
      throw error
    }
    return response
  }

  private bindAbort(entry: RequestEntry, signal: AbortSignal, response: Promise<RequestAnswer>): void {
    const cancel = () => {
      void this.entries.terminate(entry, "cancelled").catch((error: unknown) => this.ports.reportOwnerFailure(entry.pending.sessionId, error))
    }
    signal.addEventListener("abort", cancel, { once: true })
    void response.then(() => signal.removeEventListener("abort", cancel))
    if (signal.aborted) cancel()
  }

  async answer(
    requestId: string,
    reply: RequestReply,
    target: Parameters<RequestBroker["answer"]>[2],
  ): Promise<AnswerResult> {
    const sessionId = "sessionId" in target ? target.sessionId : target.start.sessionId
    const entry = this.entries.get(requestKey(sessionId, requestId))
    if (!entry) {
      if (this.entries.all().some((candidate) => candidate.pending.request.requestId === requestId)) return requestRefusal("foreign")
      const prior = this.ports.readAnswer(sessionId, requestId)
      return requestRefusal(prior && prior.kind !== "cancelled" && prior.kind !== "expired" ? "duplicate" : "stale")
    }
    if (!requestOwnerIsCurrent(this.ports, entry.authority)) return this.refusePreviousOwner(entry, sessionId, requestId)
    if (!requestTargetMatchesOwner(this.ports, entry.authority, entry.pending.sessionId, target)) return requestRefusal("foreign")
    if (reply.kind === "cancelled" || reply.kind === "expired") return requestRefusal("unoffered")
    try { await entry.published } catch { return requestRefusal("persistence") }
    if (entry.phase === "validating") {
      if (entry.pending.request.kind !== "elicitation" || entry.pending.request.mode !== "form") return requestRefusal("duplicate")
      if (reply.kind !== "rejected") throw new ElicitationValidationError("validation_busy", "This request is already being validated")
      entry.validating?.controller.abort()
      await entry.validating?.settled
    }
    if (entry.cancelRequested) return this.entries.retryTermination(entry)
    if (entry.phase !== "asked") return requestRefusal("duplicate")
    const answer = replyAnswer(entry.pending.request, reply)
    if (!answer) return requestRefusal("unoffered")
    return validateAndCommit(this.ports, this.entries, entry, answer)
  }

  cancelTurn(authority: TurnBrokerContext["authority"]): Promise<void> {
    return this.entries.cancelAll(this.entries.all().filter((entry) =>
      entry.authority.kind === "turn" && entry.authority.value.sessionId === authority.sessionId &&
      entry.authority.value.turnId === authority.turnId &&
      entry.authority.value.ownerGeneration === authority.ownerGeneration))
  }

  cancelStart(context: SessionBrokerContext): Promise<void> {
    return this.entries.cancelAll(this.entries.all().filter((entry) =>
      entry.authority.kind === "start" && entry.authority.value.operationId === context.start?.operationId &&
      entry.authority.value.sessionId === context.sessionId))
  }

  private async refusePreviousOwner(entry: RequestEntry, sessionId: string, requestId: string): Promise<AnswerResult> {
    try { await this.entries.terminate(entry, "cancelled") } catch { return requestRefusal("persistence") }
    if (!entry.foreignReported) {
      entry.foreignReported = true
      this.ports.reportOwnerFailure(sessionId, new Error(`Request ${requestId} belongs to a previous turn owner`))
    }
    return requestRefusal("foreign")
  }

  async completeElicitation(sessionId: string, connectionId: string, elicitationId: string): Promise<void> {
    this.urlConsents.complete(sessionId, connectionId, elicitationId)
  }

  closeSession(sessionId: string): void {
    this.urlConsents.clearSession(sessionId)
  }
}
