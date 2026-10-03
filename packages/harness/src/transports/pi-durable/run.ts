import { AsyncPushQueue } from "@claxedo/helpers"
import type { AgentEvent, SubmissionId, SubmissionRecord } from "@earendil-works/pi-durable"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { RoutedEvent, TurnBroker } from "../../contract"
import type { PiSessionRuntime } from "./placement"
import { piModelError } from "./errors"

export type PiRunOwnership = { requestId: string } | { inputs: readonly SubmissionId[] }

export class PiRun {
  readonly queue = new AsyncPushQueue<RoutedEvent>()
  private terminal: RoutedEvent["event"] | undefined
  private readonly steers = new Set<string>()
  private readonly submissions = new Set<SubmissionId>()
  private readonly requestId: string | undefined
  settled = false

  constructor(private readonly sessionId: string, readonly broker: Pick<TurnBroker, "ask" | "signal">, ownership: PiRunOwnership) {
    this.requestId = "requestId" in ownership ? ownership.requestId : undefined
    for (const id of "inputs" in ownership ? ownership.inputs : []) this.submissions.add(id)
  }

  receive(event: AgentEvent, routed: readonly RoutedEvent[]): void {
    for (const item of routed) this.queue.push(item)
    if (event.type === "submission") this.submission(event.record)
  }

  steer(messageId: string): () => void {
    this.steers.add(messageId)
    return () => { this.steers.delete(messageId) }
  }

  async record(runtime: PiSessionRuntime): Promise<SubmissionRecord | undefined> {
    const { requestId } = this
    if (requestId !== undefined) return runtime.harness.commit((tx) => tx.submissionByRequest(runtime.conversation.id, requestId), BACKGROUND_CONTEXT)
    const [first] = this.submissions
    return first === undefined ? undefined : (await runtime.harness.submission(first, BACKGROUND_CONTEXT))?.status(BACKGROUND_CONTEXT)
  }

  fail(error: unknown): void {
    this.settled = true
    this.queue.fail(error)
  }

  private submission(record: SubmissionRecord): void {
    if (record.requestId !== undefined && this.steers.has(record.requestId) && record.status === "placed") {
      this.steers.delete(record.requestId)
      this.queue.push({ event: { type: "input-incorporated", messageId: record.requestId }, source: { dir: "in", method: "submission" } })
    }
    if (record.requestId !== undefined && record.requestId === this.requestId) this.submissions.add(record.id)
    if (!this.submissions.has(record.id) || record.type !== "input") return
    if (record.status === "done") this.settle({ type: "finish", sessionId: this.sessionId })
    else if (record.status === "unanswered" && record.reason === "aborted") this.settle({ type: "cancelled", sessionId: this.sessionId })
    else if (record.status === "unanswered") this.settle({ type: "error", error: piModelError(record) })
  }

  private settle(event: RoutedEvent["event"]): void {
    this.terminal ??= event
  }

  endBatch(): void {
    if (this.settled || !this.terminal) return
    this.settled = true
    this.queue.push({ event: this.terminal, source: { dir: "in", method: "submission" } })
    this.queue.end()
  }
}
