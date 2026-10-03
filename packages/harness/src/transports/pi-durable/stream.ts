import { errorMessage } from "@claxedo/helpers"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { watchEvents, type AgentEvent, type AgentEventStream } from "@earendil-works/pi-durable"
import type { Logger, OutsideTurnEvent, RoutedEvent, SessionBroker } from "../../contract"
import { piDurableEvents, type PiEvents } from "./events"
import { piSession } from "./errors"
import type { PiSessionRuntime } from "./placement"
import { PiProviderTurn } from "./provider-turn"
import { PiRun } from "./run"

type Owner = { kind: "idle" } | { kind: "turn"; run: PiRun } | { kind: "provider"; turn: PiProviderTurn }

export type PiStreamHost = { sessionId: string; runtime: PiSessionRuntime; broker: SessionBroker; log: Logger; stop(): Promise<void> }

const OUTSIDE: readonly string[] = ["harness-notice", "diagnostic", "mcp-server-status"]

export class PiSessionStream {
  private owner: Owner = { kind: "idle" }
  private readonly translate: PiEvents
  private watch: AgentEventStream | undefined

  constructor(private readonly host: PiStreamHost) {
    this.translate = piDurableEvents(host.sessionId)
  }

  async open(): Promise<void> {
    const watch = await watchEvents(this.host.runtime.harness, this.host.runtime.conversation.id, BACKGROUND_CONTEXT)
    this.watch = watch
    const run = watch.snapshot.run
    if (run) this.owner = { kind: "provider", turn: this.provider(run.inputs) }
    this.batch([watch.snapshot])
    watch.start(async (events) => this.batch(events))
  }

  get busy(): boolean { return this.owner.kind !== "idle" }

  get active(): PiRun | undefined {
    return this.owner.kind === "turn" ? this.owner.run : this.owner.kind === "provider" ? this.owner.turn.current : undefined
  }

  claim(run: PiRun): () => void {
    if (this.owner.kind !== "idle") throw piSession("A Pi turn is already active")
    this.owner = { kind: "turn", run }
    return () => { if (this.owner.kind === "turn" && this.owner.run === run) this.owner = { kind: "idle" } }
  }

  async close(): Promise<void> {
    const failure = piSession("The Pi session closed")
    if (this.owner.kind === "turn") this.owner.run.fail(failure)
    if (this.owner.kind === "provider") this.owner.turn.fail(failure)
    this.owner = { kind: "idle" }
    await this.watch?.stop()
  }

  private batch(events: readonly AgentEvent[]): void {
    for (const event of events) this.receive(event)
    if (this.owner.kind === "provider") this.owner.turn.endBatch()
    if (this.owner.kind !== "turn") return
    this.owner.run.endBatch()
    if (this.owner.run.settled) this.owner = { kind: "idle" }
  }

  private receive(event: AgentEvent): void {
    const routed = this.translate(event)
    if (this.owner.kind === "idle" && event.type === "run_start") this.owner = { kind: "provider", turn: this.provider(event.inputs) }
    if (this.owner.kind === "turn") this.owner.run.receive(event, routed)
    else if (this.owner.kind === "provider") this.owner.turn.receive(event, routed)
    else this.outside(routed)
  }

  private provider(inputs: readonly number[]): PiProviderTurn {
    const turn: PiProviderTurn = new PiProviderTurn({ ...this.host, inputs,
      current: () => this.owner.kind === "provider" && this.owner.turn === turn,
      ended: () => { if (this.owner.kind === "provider" && this.owner.turn === turn) this.owner = { kind: "idle" } } })
    return turn
  }

  private outside(events: readonly RoutedEvent[]): void {
    for (const { event } of events) {
      if (OUTSIDE.includes(event.type)) void this.host.broker.publish(event as OutsideTurnEvent).then(undefined, (error: unknown) =>
        this.host.log.error("Pi notice publication failed", { error: errorMessage(error) }))
      else this.host.log.debug("Pi event outside any turn has no session surface", { type: event.type })
    }
  }
}
