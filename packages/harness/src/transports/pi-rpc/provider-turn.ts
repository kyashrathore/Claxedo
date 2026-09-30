import { randomUUID } from "node:crypto"
import { asRecord } from "@claxedo/helpers/guards"
import { errorMessage } from "@claxedo/helpers"
import type { Clock, Logger, ProviderTurnInput, RoutedEvent, SessionBroker, TurnBroker } from "../../contract"
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
  if (message.type !== "message_start" || content?.role !== "user") return { reason: "provider" }
  const blocks = Array.isArray(content.content) ? content.content : []
  const text = typeof content.content === "string" ? content.content
    : blocks.map((block) => asRecord(block)).flatMap((block) => block?.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n")
  return { reason: "provider", userMessage: { id: `msg_${randomUUID()}`, text } }
}

export class PiProviderTurn {
  private held: Held[] = []
  private run?: PiRun
  private admitting = false

  constructor(private readonly host: PiProviderHost) {}

  get current(): PiRun | undefined { return this.run }

  receive(message: PiMessage, events: readonly RoutedEvent[]): void {
    if (this.run) return this.run.receive(message, events)
    this.held.push({ message, events })
    const input = this.admitting ? undefined : opening(message)
    if (input) this.admit(input)
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
