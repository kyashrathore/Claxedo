import { asRecord } from "@claxedo/helpers/guards"
import { errorMessage } from "@claxedo/helpers"
import type { Clock, Logger, ProviderTurnInput, RoutedEvent, SessionBroker, TurnBroker } from "../../contract"
import { piUserText } from "./events"
import type { PiMessage, PiRpc } from "./rpc"
import { PiRun } from "./run"

export type PiProviderHost = {
  sessionId: string
  rpc: PiRpc
  broker: SessionBroker
  clock: Clock
  log: Logger
  stop(): Promise<void>
  ended(turn: PiProviderTurn): boolean
}

type Held = { message: PiMessage; events: readonly RoutedEvent[] }

function opening(message: PiMessage): ProviderTurnInput | undefined {
  if (message.type === "agent_start" || message.type === "turn_start") return undefined
  const content = asRecord(message.message)
  if ((message.type === "message_start" || message.type === "message_end") && content?.role === "system") return undefined
  const text = piUserText(message)
  return text ? { reason: "provider", detail: text } : { reason: "provider" }
}

export class PiProviderTurn {
  private held: Held[] = []
  private run?: PiRun
  private admitting = false
  private failure?: { error: unknown }

  constructor(private readonly host: PiProviderHost) {}

  get current(): PiRun | undefined { return this.run }

  receive(message: PiMessage, events: readonly RoutedEvent[]): void {
    if (this.run) return this.run.receive(message, events)
    this.held.push({ message, events })
    const input = this.admitting ? undefined : opening(message)
    if (input) this.admit(input)
  }

  fail(error: unknown): void {
    if (this.run) return this.run.queue.fail(error)
    this.failure = { error }
    if (!this.admitting) this.host.ended(this)
  }

  private admit(input: ProviderTurnInput): void {
    this.admitting = true
    void this.host.broker.admitProviderTurn(input, (broker) => this.stream(broker)).then((admission) => {
      if (admission.admitted || !this.host.ended(this)) return
      this.host.log.warn("Pi started a run Claxedo could not admit as a turn; it is stopped", { reason: admission.reason })
      return this.host.stop()
    }).then(undefined, (error: unknown) => {
      this.host.log.error("Pi provider turn failed", { error: errorMessage(error) })
      this.host.broker.reportFailure(error)
    })
  }

  private async *stream(broker: TurnBroker): AsyncIterable<RoutedEvent> {
    const run = new PiRun(this.host.rpc, this.host.sessionId, this.host.clock, broker)
    const stop = () => { void this.host.stop().then(undefined, (error: unknown) => this.host.broker.reportFailure(error)) }
    broker.signal.addEventListener("abort", stop, { once: true })
    for (const held of this.held.splice(0)) run.receive(held.message, held.events)
    if (this.failure) run.queue.fail(this.failure.error)
    this.run = run
    try {
      yield* run.queue
      await run.answered()
    } finally {
      broker.signal.removeEventListener("abort", stop)
      run.close()
      this.host.ended(this)
    }
  }
}
