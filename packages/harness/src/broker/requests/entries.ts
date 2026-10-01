import type { AnswerResult, PendingRequest, RequestAnswer } from "../../contract/broker"
import type { BrokerPorts } from "../ports"
import { requestRefusal, type RequestAuthority } from "./authority"
import { requestKey } from "./request-key"

export type RequestEntry = {
  pending: PendingRequest
  authority: RequestAuthority
  phase: "asked" | "validating" | "committing" | "answered" | "cancelled" | "expired"
  resolve(answer: RequestAnswer): void
  expiry?: unknown
  validating?: { controller: AbortController; settled: Promise<void> }
  cancelRequested?: "cancelled" | "expired"
  published?: Promise<void>
  termination?: Promise<void>
  foreignReported?: true
}

export class RequestEntries {
  private readonly entries = new Map<string, RequestEntry>()
  private readonly asking = new Set<string>()

  constructor(private readonly ports: BrokerPorts) {}

  get(key: string): RequestEntry | undefined {
    return this.entries.get(key)
  }

  has(key: string): boolean {
    return this.entries.has(key) || this.asking.has(key)
  }

  all(): RequestEntry[] {
    return [...this.entries.values()]
  }

  reserve(key: string): void {
    this.asking.add(key)
  }

  release(key: string): void {
    this.asking.delete(key)
  }

  add(key: string, entry: RequestEntry): void {
    this.entries.set(key, entry)
  }

  remove(key: string): void {
    this.entries.delete(key)
  }

  finish(entry: RequestEntry, answer: RequestAnswer): void {
    entry.phase = answer.kind === "cancelled" ? "cancelled" : answer.kind === "expired" ? "expired" : "answered"
    if (entry.expiry !== undefined) this.ports.clock.clearTimeout(entry.expiry)
    this.entries.delete(requestKey(entry.pending.sessionId, entry.pending.request.requestId))
    entry.resolve(answer)
  }

  async terminate(entry: RequestEntry, kind: "cancelled" | "expired"): Promise<void> {
    if (entry.phase === "answered" || entry.phase === "cancelled" || entry.phase === "expired") return
    entry.cancelRequested = kind
    entry.validating?.controller.abort()
    await entry.published
    if (entry.phase === "committing") return
    await this.finishTermination(entry)
  }

  async finishTermination(entry: RequestEntry): Promise<void> {
    if (entry.termination) return entry.termination
    if (entry.phase === "cancelled" || entry.phase === "expired") return
    entry.termination = this.persistTermination(entry)
    try { await entry.termination } finally { entry.termination = undefined }
  }

  async retryTermination(entry: RequestEntry): Promise<AnswerResult> {
    try { await this.finishTermination(entry); return requestRefusal("duplicate") }
    catch { return requestRefusal("persistence") }
  }

  async cancelAll(entries: readonly RequestEntry[]): Promise<void> {
    const results = await Promise.allSettled(entries.map((entry) => this.terminate(entry, "cancelled")))
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, `${failures.length} of ${entries.length} requests could not be cancelled`)
  }

  private async persistTermination(entry: RequestEntry): Promise<void> {
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
}
