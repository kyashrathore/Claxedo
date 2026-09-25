import type {
  AnswerResult,
  PendingRequest,
  RequestAnswer,
  RequestBroker,
  RequestScope,
  TurnRequest,
} from "../../contract/broker"
import type { BrokerPorts, SessionBrokerContext, TurnBrokerContext } from "../ports"
import { hasGrant, saveGrant } from "../grants"
import { optionMatchesDecision, substitutePermissionOption } from "../options"
import { requestTargetMatchesOwner, requestRefusal, type RequestAuthority } from "./authority"
import { elicitationQuestion } from "./elicitation-question"
import { validateAnswer } from "./validation"
import { ElicitationValidationError } from "@claxedo/agent-runtime-contract"

type Entry = {
  pending: PendingRequest
  authority: RequestAuthority
  phase: "asked" | "validating" | "committing" | "answered" | "cancelled" | "expired"
  resolve(answer: RequestAnswer): void
  expiry?: unknown
  validating?: AbortController
  cancelRequested?: "cancelled" | "expired"
}

export class RequestTable implements RequestBroker {
  private readonly entries = new Map<string, Entry>()
  constructor(private readonly ports: BrokerPorts) {}

  list(scope: RequestScope): readonly PendingRequest[] {
    return [...this.entries.values()]
      .filter((entry) => entry.phase === "asked" || entry.phase === "validating" || entry.phase === "committing")
      .filter((entry) => "sessionId" in scope
        ? entry.pending.sessionId === scope.sessionId
        : entry.authority.value.directory === scope.directory)
      .map((entry) => entry.pending)
  }

  askTurn(context: TurnBrokerContext, request: TurnRequest): Promise<RequestAnswer> {
    return this.ask({ kind: "turn", value: context.authority }, request, context.expiresAt, context.signal)
  }

  askStart(context: SessionBrokerContext, request: TurnRequest): Promise<RequestAnswer> {
    if (!context.start) throw new Error("Session ask requires a start binding")
    return this.ask({ kind: "start", value: context.start }, request, context.expiresAt)
  }

  private async ask(
    authority: RequestAuthority,
    request: TurnRequest,
    expiresAt?: number,
    signal?: AbortSignal,
  ): Promise<RequestAnswer> {
    const immediate = await this.preflight(authority, request, expiresAt, signal)
    if (immediate) return immediate
    const sessionId = authority.value.sessionId
    const pending = this.pending(authority, request)
    let resolve!: (answer: RequestAnswer) => void
    const response = new Promise<RequestAnswer>((done) => { resolve = done })
    const entry: Entry = { pending, authority, phase: "asked", resolve }
    this.entries.set(request.requestId, entry)
    try {
      await this.publishAsked(pending)
      if (expiresAt !== undefined) {
        entry.expiry = this.ports.clock.setTimeout(() => {
          void this.terminate(entry, "expired").catch((error: unknown) => this.ports.reportOwnerFailure(sessionId, error))
        }, Math.max(0, expiresAt - this.ports.clock.now()))
      }
      if (signal) this.bindAbort(entry, signal, response)
    } catch (error) {
      this.entries.delete(request.requestId)
      throw error
    }
    return response
  }

  private async preflight(
    authority: RequestAuthority, request: TurnRequest, expiresAt?: number, signal?: AbortSignal,
  ): Promise<RequestAnswer | undefined> {
    if (signal?.aborted) return { kind: "cancelled" }
    if (this.entries.has(request.requestId) || this.ports.readAnswer(request.requestId)) {
      throw new Error(`Request ${request.requestId} is already registered`)
    }
    const sessionId = authority.value.sessionId
    if (request.kind === "permission" && request.permission.sessionID !== sessionId) throw new Error("Permission belongs to another session")
    if (request.kind === "question" && request.question.sessionID !== sessionId) throw new Error("Question belongs to another session")
    if (expiresAt !== undefined && expiresAt <= this.ports.clock.now()) {
      const pending = this.pending(authority, request)
      await this.ports.persistAnswer(pending, { kind: "expired" }, false)
      return { kind: "expired" }
    }
    if (request.kind === "permission" && hasGrant(this.ports, sessionId, request)) {
      const automatic = substitutePermissionOption({ kind: "permission", decision: "allow_always" }, request.options)
      const pending = this.pending(authority, request)
      await this.ports.persistAnswer(pending, automatic, true)
      if (signal?.aborted) {
        await this.ports.persistAnswer(pending, { kind: "cancelled" }, false)
        return { kind: "cancelled" }
      }
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
    const entry = this.entries.get(requestId)
    if (!entry) return requestRefusal(this.ports.readAnswer(requestId) ? "duplicate" : "stale")
    if (!requestTargetMatchesOwner(this.ports, entry.authority, target)) return requestRefusal("foreign")
    if (entry.phase === "validating") {
      throw new ElicitationValidationError("validation_busy", "This request is already being validated")
    }
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
      if (entry.cancelRequested) return requestRefusal("duplicate")
      entry.phase = "asked"
      throw error
    }
    entry.validating = undefined
    if (entry.cancelRequested) return requestRefusal("duplicate")
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
      const events = await this.ports.persistAnswer(entry.pending, answer, false)
      if (!entry.cancelRequested && entry.pending.request.kind === "permission") {
        await saveGrant(this.ports, entry.pending.sessionId, entry.pending.request, answer)
      }
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

  async cancelTurn(authority: TurnBrokerContext["authority"]): Promise<void> {
    const entries = [...this.entries.values()].filter((entry) =>
      entry.authority.kind === "turn" && entry.authority.value.sessionId === authority.sessionId &&
      entry.authority.value.turnId === authority.turnId &&
      entry.authority.value.ownerGeneration === authority.ownerGeneration)
    for (const entry of entries) await this.terminate(entry, "cancelled")
  }

  async cancelStart(context: SessionBrokerContext): Promise<void> {
    for (const entry of Array.from(this.entries.values())) {
      if (entry.authority.kind === "start" && entry.authority.value.operationId === context.start?.operationId &&
        entry.authority.value.sessionId === context.sessionId) await this.terminate(entry, "cancelled")
    }
  }

  private async terminate(entry: Entry, kind: "cancelled" | "expired"): Promise<void> {
    if (entry.phase === "answered" || entry.phase === "cancelled" || entry.phase === "expired") return
    entry.cancelRequested = kind
    entry.validating?.abort()
    if (entry.phase === "committing") return
    await this.finishTermination(entry)
  }

  private async finishTermination(entry: Entry): Promise<void> {
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
    this.entries.delete(entry.pending.request.requestId)
    entry.resolve(answer)
  }

  private pending(authority: RequestAuthority, request: TurnRequest): PendingRequest {
    return { sessionId: authority.value.sessionId, request, askedAt: this.ports.clock.now(),
      ...(authority.kind === "start" ? { start: authority.value } : {}) }
  }

  private async publishAsked(pending: PendingRequest): Promise<void> {
    const request = pending.request
    if (request.kind === "permission") {
      await this.ports.publish({ id: `permission.asked:${request.requestId}`, type: "permission.asked", properties: request.permission })
    } else if (request.kind === "question") {
      await this.ports.publish({ id: `question.asked:${request.requestId}`, type: "question.asked", properties: request.question })
    } else {
      await this.ports.publish({ id: `question.asked:${request.requestId}`, type: "question.asked", properties: elicitationQuestion(pending) })
    }
  }
}
