import { errorMessage } from "@claxedo/helpers"
import type { Clock, Logger, OutsideTurnEvent, RoutedEvent, SessionBroker } from "../../contract"
import { TransportError } from "../../contract/errors"
import { piEvents } from "./events"
import { PiProviderTurn } from "./provider-turn"
import type { PiMessage, PiRpc } from "./rpc"
import type { PiRun } from "./run"
import { answerPiDialog, piDialog } from "./ui"

type Owner = { kind: "idle" } | { kind: "turn"; run: PiRun } | { kind: "provider"; turn: PiProviderTurn }

export type PiStreamHost = { sessionId: string; rpc: PiRpc; broker: SessionBroker; clock: Clock; log: Logger; stop(): Promise<void> }

function outsideTurnEvent(event: RoutedEvent["event"]): OutsideTurnEvent | undefined {
  switch (event.type) {
    case "harness-notice":
    case "diagnostic":
    case "session-title":
    case "mcp-server-status":
      return event
    default:
      return undefined
  }
}

export class PiSessionStream {
  private owner: Owner = { kind: "idle" }
  private renaming: string | undefined
  private readonly translate: (message: PiMessage) => RoutedEvent[]
  constructor(private readonly host: PiStreamHost) {
    this.translate = piEvents(host.sessionId)
    host.rpc.onEvent((message) => this.receive(message))
    host.rpc.onFailure((error) => this.fail(error))
  }

  get busy(): boolean { return this.owner.kind !== "idle" }

  get run(): PiRun | undefined { return this.owner.kind === "turn" ? this.owner.run : undefined }

  get active(): PiRun | undefined { return this.owner.kind === "provider" ? this.owner.turn.current : this.run }

  claim(run: PiRun): () => void {
    if (this.owner.kind !== "idle") throw new TransportError("pi", "session", "Pi turn already active")
    this.owner = { kind: "turn", run }
    return () => { if (this.owner.kind === "turn" && this.owner.run === run) this.owner = { kind: "idle" } }
  }

  private fail(error: Error): void {
    if (this.owner.kind === "turn") this.owner.run.queue.fail(error)
    else if (this.owner.kind === "provider") this.owner.turn.fail(error)
  }

  async rename(name: string, send: () => Promise<unknown>): Promise<void> {
    this.renaming = name.trim()
    try { await send() } finally { this.renaming = undefined }
  }

  private withoutRenameEcho(events: RoutedEvent[]): RoutedEvent[] {
    if (this.renaming === undefined) return events
    return events.filter(({ event }) => event.type !== "session-title" || event.title !== this.renaming)
  }

  private receive(message: PiMessage): void {
    const events = this.withoutRenameEcho(this.translate(message))
    if (this.owner.kind === "idle" && message.type === "agent_start") this.owner = { kind: "provider", turn: this.provider() }
    if (this.owner.kind === "turn") this.owner.run.receive(message, events)
    else if (this.owner.kind === "provider") this.owner.turn.receive(message, events)
    else this.outside(message, events)
    if (message.type === "agent_settled") this.owner = { kind: "idle" }
  }

  private provider(): PiProviderTurn {
    return new PiProviderTurn({ ...this.host, ended: (turn) => {
      if (this.owner.kind !== "provider" || this.owner.turn !== turn) return false
      this.owner = { kind: "idle" }
      return true
    } })
  }

  private outside(message: PiMessage, events: readonly RoutedEvent[]): void {
    for (const { event } of events) {
      const outside = outsideTurnEvent(event)
      if (outside) void this.host.broker.publish(outside).then(undefined, (error: unknown) =>
        this.host.log.error("Pi notice publication failed", { error: errorMessage(error) }))
      else this.host.log.debug("Pi event outside any turn has no session surface", { type: event.type })
    }
    if (piDialog(message)) void answerPiDialog(message, this.host.rpc, this.host.broker, this.host.sessionId, this.host.clock.now(),
      new AbortController().signal).then(undefined, (error: unknown) => this.host.broker.reportFailure(error))
  }
}
