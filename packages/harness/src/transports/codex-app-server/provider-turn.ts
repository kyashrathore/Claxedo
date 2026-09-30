import { asRecordOrEmpty, asString } from "@claxedo/helpers/guards"
import type { AsyncPushQueue } from "@claxedo/helpers"
import type { HarnessSession, RoutedEvent, SessionBroker, TurnBroker } from "../../contract"
import { admitQueuedProviderTurn } from "../../contract"
import { CodexEvents } from "./events"
import { CodexTransportError } from "./errors"
import type { RpcMessage } from "./rpc"
import { codexStopDeadline, type CodexTerminals } from "./terminals"
import type { CodexUsageLedger } from "./usage"

export type ProviderTurnEntry = { session: HarnessSession; broker: SessionBroker; usage: CodexUsageLedger; terminals: CodexTerminals
  providerTurn?: CodexProviderTurn; released: Promise<void>; idle(): void }

type Ending = { error?: unknown }

export class CodexProviderTurn {
  readonly events: CodexEvents
  readonly broker: Promise<TurnBroker | undefined>
  private queue?: AsyncPushQueue<RoutedEvent>
  private held: RoutedEvent[] = []
  private ending?: Ending
  private started!: (broker: TurnBroker | undefined) => void

  constructor(readonly id: string, threadId: string) {
    this.events = new CodexEvents(threadId)
    this.broker = new Promise((resolve) => { this.started = resolve })
  }

  push(event: RoutedEvent): void { if (this.queue) this.queue.push(event); else this.held.push(event) }
  end(): void { if (this.queue) this.queue.end(); else this.ending ??= {} }
  fail(error: unknown): void { if (this.queue) this.queue.fail(error); else this.ending ??= { error } }
  drained(): Promise<void> { return this.queue ? this.queue.drained() : Promise.resolve() }

  admit(entry: ProviderTurnEntry): Promise<void> {
    return new Promise((released) => {
      const { queue } = admitQueuedProviderTurn(entry.broker, {
        started: (turnBroker, turn) => {
          entry.usage.attach({ sessionId: entry.session.binding.sessionId, directory: entry.session.directory, assistantMessageId: turn.assistantMessageId })
          turnBroker.signal.addEventListener("abort", () => { void entry.terminals.stop(this.id, codexStopDeadline())
            .then(undefined, (error: unknown) => entry.broker.reportFailure(error)) }, { once: true })
          this.started(turnBroker)
        },
        ended: () => {},
        refused: () => { this.release(entry); released() },
        settled: (settlement) => {
          if (settlement.state === "failed") entry.broker.reportFailure(new CodexTransportError("session", settlement.error))
          if (settlement.state !== "completed") queue.end()
          this.release(entry)
          released()
        },
      })
      this.queue = queue
      for (const event of this.held.splice(0)) queue.push(event)
      if (this.ending?.error !== undefined) queue.fail(this.ending.error)
      else if (this.ending) queue.end()
    })
  }

  private release(entry: ProviderTurnEntry): void {
    this.started(undefined)
    this.held = []
    if (entry.providerTurn === this) entry.providerTurn = undefined
    entry.idle()
  }
}

export function admitCodexProviderTurn(entry: ProviderTurnEntry, message: RpcMessage): void {
  const id = asString(asRecordOrEmpty(asRecordOrEmpty(message.params).turn).id)
  if (!id) return
  const turn = new CodexProviderTurn(id, entry.session.binding.upstreamSessionId)
  entry.providerTurn = turn
  entry.released = entry.released.then(() => turn.admit(entry))
  for (const event of turn.events.ingest(message)) turn.push(event)
}
