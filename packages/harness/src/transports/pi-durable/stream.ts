import { errorMessage } from "@claxedo/helpers"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { watchEvents, type AgentEvent, type SubmissionId, type AgentEventStream, type WatchEnd } from "@earendil-works/pi-durable"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import type { Logger, OutsideTurnEvent, RoutedEvent, SessionBroker } from "../../contract"
import { piDurableEvents, type PiEvents } from "./events"
import { piSession } from "./errors"
import type { PiSessionRuntime } from "./placement"
import { PiProviderTurn } from "./provider-turn"
import { PiRun } from "./run"

type Owner = { kind: "idle" } | { kind: "turn"; run: PiRun } | { kind: "provider"; turn: PiProviderTurn }

export type PiStreamHost = { sessionId: string; directory: string; runtime: PiSessionRuntime; broker: SessionBroker; log: Logger; stop(): Promise<void> }

const OUTSIDE: readonly string[] = ["harness-notice", "diagnostic", "mcp-server-status", "session-compaction"]

const outsideTurn = (event: AgentRuntimeEvent): event is OutsideTurnEvent => OUTSIDE.includes(event.type)

export class PiSessionStream {
  private owner: Owner = { kind: "idle" }
  private assistantMessageId: string | undefined
  private readonly translate: PiEvents
  private watch: AgentEventStream | undefined
  private ended: Error | undefined

  constructor(private readonly host: PiStreamHost) {
    this.translate = piDurableEvents(host.sessionId)
  }

  async open(): Promise<void> {
    const watch = await watchEvents(this.host.runtime.harness, this.host.runtime.conversation.id, BACKGROUND_CONTEXT)
    this.watch = watch
    const run = watch.snapshot.run
    if (run) this.owner = { kind: "provider", turn: this.provider(run.inputs) }
    this.batch([watch.snapshot])
    watch.start(async (events) => {
      this.batch(events)
      const run = this.active
      if (run && events.some((event) => event.type === "snapshot")) await this.resync(run)
    })
    void watch.closed.then((end) => this.lose(end))
  }

  async resync(run: PiRun): Promise<void> {
    if (run.settled) return
    const record = await run.record(this.host.runtime)
    if (record && this.active === run) this.batch([{ type: "submission", record }])
  }

  get busy(): boolean { return this.owner.kind !== "idle" }

  get active(): PiRun | undefined {
    return this.owner.kind === "turn" ? this.owner.run : this.owner.kind === "provider" ? this.owner.turn.current : undefined
  }

  claim(run: PiRun, assistantMessageId: string): () => void {
    if (this.ended) throw this.ended
    if (this.owner.kind !== "idle") throw piSession("A Pi turn is already active")
    this.owner = { kind: "turn", run }
    this.assistantMessageId = assistantMessageId
    return () => { if (this.owner.kind === "turn" && this.owner.run === run) this.owner = { kind: "idle" } }
  }

  async close(): Promise<void> {
    this.fail(this.ended = piSession("The Pi session closed"))
    await this.watch?.stop()
  }

  private lose(end: WatchEnd): void {
    if (this.ended) return
    this.ended = piSession(`Pi's event stream ended (${end.reason})${end.reason === "listener_error" ? `: ${errorMessage(end.error)}` : ""}`)
    this.host.log.error("Pi event stream ended under a live session", { sessionId: this.host.sessionId, reason: end.reason })
    this.fail(this.ended)
  }

  private fail(failure: Error): void {
    if (this.owner.kind === "turn") this.owner.run.fail(failure)
    if (this.owner.kind === "provider") this.owner.turn.fail(failure)
    this.owner = { kind: "idle" }
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

  private provider(inputs: readonly SubmissionId[]): PiProviderTurn {
    const turn: PiProviderTurn = new PiProviderTurn({ ...this.host, inputs,
      current: () => this.owner.kind === "provider" && this.owner.turn === turn,
      admitted: (assistantMessageId) => { this.assistantMessageId = assistantMessageId },
      ended: () => { if (this.owner.kind === "provider" && this.owner.turn === turn) this.owner = { kind: "idle" } } })
    return turn
  }

  private outside(events: readonly RoutedEvent[]): void {
    const { broker, log } = this.host
    for (const { event } of events) {
      if (event.type === "usage" && this.assistantMessageId) {
        broker.meter({ sessionId: broker.sessionId, directory: this.host.directory, assistantMessageId: this.assistantMessageId, usage: event })
      } else if (outsideTurn(event)) {
        void broker.publish(event, this.assistantMessageId).then(undefined, (error: unknown) => log.error("Pi notice publication failed", { error: errorMessage(error) }))
      } else log.warn("Pi event outside any turn has no session surface", { type: event.type })
    }
  }
}
