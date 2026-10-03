import { errorMessage } from "@claxedo/helpers"
import type { AgentEvent } from "@earendil-works/pi-durable"
import type { Logger, RoutedEvent, SessionBroker, TurnBroker } from "../../contract"
import { PiRun } from "./run"

export type PiProviderHost = {
  sessionId: string
  broker: SessionBroker
  log: Logger
  inputs: readonly number[]
  stop(): Promise<void>
  current(): boolean
  ended(): void
}

type Held = { event: AgentEvent; routed: readonly RoutedEvent[] }

export class PiProviderTurn {
  private held: Held[] = []
  private run: PiRun | undefined
  private failure: { error: unknown } | undefined
  private finished = false

  constructor(private readonly host: PiProviderHost) {
    void host.broker.admitProviderTurn({ reason: "continuation", current: () => host.current() }, (broker) => this.stream(broker)).then(async (admission) => {
      if (admission.admitted) return
      host.ended()
      if (admission.reason === "closed") await host.stop()
      else host.log.warn("Pi resumed a run Claxedo could not admit as a turn", { reason: admission.reason })
    }).then(undefined, (error: unknown) => {
      host.log.error("Pi continuation turn failed", { error: errorMessage(error) })
      host.broker.reportFailure(error)
    })
  }

  get current(): PiRun | undefined { return this.run }

  receive(event: AgentEvent, routed: readonly RoutedEvent[]): void {
    if (this.run) this.run.receive(event, routed)
    else this.held.push({ event, routed })
  }

  endBatch(): void {
    this.run?.endBatch()
    if (!this.run?.settled || this.finished) return
    this.finished = true
    this.host.ended()
  }

  fail(error: unknown): void {
    if (this.run) return this.run.fail(error)
    this.failure = { error }
  }

  private async *stream(broker: TurnBroker): AsyncIterable<RoutedEvent> {
    const run = new PiRun(this.host.sessionId, broker, { inputs: this.host.inputs })
    const stop = () => { void this.host.stop().then(undefined, (error: unknown) => this.host.broker.reportFailure(error)) }
    broker.signal.addEventListener("abort", stop, { once: true })
    for (const held of this.held.splice(0)) run.receive(held.event, held.routed)
    if (this.failure) run.fail(this.failure.error)
    this.run = run
    this.endBatch()
    try { yield* run.queue }
    finally {
      broker.signal.removeEventListener("abort", stop)
      if (!this.finished) { this.finished = true; this.host.ended() }
    }
  }
}
