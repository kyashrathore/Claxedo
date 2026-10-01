import type { AdapterCancelOutcome } from "@claxedo/agent-runtime-contract"
import { AsyncPushQueue, errorMessage, singleFlightUntil } from "@claxedo/helpers"
import type { Clock, Deadline, RoutedEvent, TurnBroker } from "../../contract"
import { TransportError } from "../../contract/errors"
import type { PiMessage, PiRpc } from "./rpc"
import { PiSteers } from "./steers"
import { answerPiDialog, piDialog } from "./ui"

export class PiRun {
  readonly queue = new AsyncPushQueue<RoutedEvent>()
  readonly steers = new PiSteers()
  private readonly dialogs = new Set<Promise<void>>()
  private readonly dialogAbort = new AbortController()
  started = false
  settled = false
  prompted = false
  withdrawn = false
  readonly stop = singleFlightUntil((deadline: Deadline) => this.stopPrompted(deadline), () => false)

  constructor(private readonly rpc: PiRpc, private readonly sessionId: string, private readonly clock: Clock,
    private readonly broker: Pick<TurnBroker, "ask">) {}

  receive(message: PiMessage, events: readonly RoutedEvent[]): void {
    const incorporated = this.steers.incorporated(message)
    if (incorporated) this.queue.push(incorporated)
    for (const event of events) this.queue.push(event)
    if (message.type === "agent_start") this.started = true
    if (piDialog(message)) this.answer(message)
    if (message.type === "agent_settled") this.settle()
  }

  finishUnstarted(): void {
    this.queue.push({ event: { type: "finish", sessionId: this.sessionId }, source: { dir: "in", method: "prompt" } })
    this.settle()
  }

  withdraw(): void {
    this.withdrawn = true
    this.queue.end()
  }

  answered(): Promise<unknown> { return Promise.all(this.dialogs) }

  close(): void { this.dialogAbort.abort() }

  private answer(message: PiMessage): void {
    const task = answerPiDialog(message, this.rpc, this.broker, this.sessionId, this.clock.now(), this.dialogAbort.signal)
    this.dialogs.add(task)
    void task.then(() => this.dialogs.delete(task), (error: unknown) => this.queue.fail(error))
  }

  private async stopPrompted(deadline: Deadline): Promise<AdapterCancelOutcome> {
    try {
      await this.rpc.stop(deadline)
      return { execution: this.settled ? "terminal" : "unknown", cleanup: "unknown" }
    } catch (error) {
      return { execution: "unknown", cleanup: "owned",
        error: { code: error instanceof TransportError && error.code === "timeout" ? "cancellation_timeout" : "provider_unreachable",
          message: errorMessage(error) } }
    }
  }

  private settle(): void {
    this.settled = true
    this.dialogAbort.abort()
    this.queue.end()
  }
}
