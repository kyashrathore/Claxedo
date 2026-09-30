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

const OUTSIDE: readonly string[] = ["harness-notice", "diagnostic", "session-title", "mcp-server-status"]

export class PiSessionStream {
  private owner: Owner = { kind: "idle" }
  private readonly translate: (message: PiMessage) => RoutedEvent[]
  readonly detach: () => void

  constructor(private readonly host: PiStreamHost) {
    this.translate = piEvents(host.sessionId)
    this.detach = host.rpc.onEvent((message) => this.receive(message))
  }

  get busy(): boolean { return this.owner.kind !== "idle" }

  get run(): PiRun | undefined { return this.owner.kind === "turn" ? this.owner.run : undefined }

  get active(): PiRun | undefined { return this.owner.kind === "provider" ? this.owner.turn.current : this.run }

  claim(run: PiRun): () => void {
    if (this.owner.kind !== "idle") throw new TransportError("pi", "session", "Pi turn already active")
    this.owner = { kind: "turn", run }
    return () => { if (this.owner.kind === "turn" && this.owner.run === run) this.owner = { kind: "idle" } }
  }

  private receive(message: PiMessage): void {
    const events = this.translate(message)
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
      if (OUTSIDE.includes(event.type)) void this.host.broker.publish(event as OutsideTurnEvent).then(undefined, (error: unknown) =>
        this.host.log.error("Pi notice publication failed", { error: errorMessage(error) }))
      else this.host.log.debug("Pi event outside any turn has no session surface", { type: event.type })
    }
    if (piDialog(message)) void answerPiDialog(message, this.host.rpc, this.host.broker, this.host.sessionId, this.host.clock.now(),
      new AbortController().signal).then(undefined, (error: unknown) => this.host.broker.reportFailure(error))
  }
}
