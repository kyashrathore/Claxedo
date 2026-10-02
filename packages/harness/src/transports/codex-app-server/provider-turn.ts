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

export class CodexProviderTurn {
  readonly events: CodexEvents
  readonly released: Promise<void>
  private readonly admitted = Promise.withResolvers<TurnBroker | undefined>()
  private readonly queue: AsyncPushQueue<RoutedEvent>

  constructor(readonly id: string, entry: ProviderTurnEntry) {
    this.events = new CodexEvents(entry.session.binding.upstreamSessionId)
    const released = Promise.withResolvers<void>()
    this.released = released.promise
    this.queue = admitQueuedProviderTurn(entry.broker, {
      started: (turnBroker, turn) => {
        entry.usage.attach({ sessionId: entry.session.binding.sessionId, directory: entry.session.directory, assistantMessageId: turn.assistantMessageId })
        turnBroker.signal.addEventListener("abort", () => { void entry.terminals.stop(this.id, codexStopDeadline())
          .then(undefined, (error: unknown) => entry.broker.reportFailure(error)) }, { once: true })
        this.admitted.resolve(turnBroker)
      },
      ended: () => {},
      refused: () => { this.release(entry); released.resolve() },
      settled: (settlement) => {
        if (settlement.state === "failed") entry.broker.reportFailure(new CodexTransportError("session", settlement.error))
        if (settlement.state !== "completed") this.queue.end()
        this.release(entry)
        released.resolve()
      },
    }).queue
  }

  get broker(): Promise<TurnBroker | undefined> { return this.admitted.promise }
  push(event: RoutedEvent): void { this.queue.push(event) }
  end(): void { this.queue.end() }
  fail(error: unknown): void { this.queue.fail(error) }
  async delivered(): Promise<void> {
    await this.broker
    await this.queue.drained()
  }

  private release(entry: ProviderTurnEntry): void {
    this.admitted.resolve(undefined)
    if (entry.providerTurn === this) entry.providerTurn = undefined
    entry.idle()
  }
}

export function admitCodexProviderTurn(entry: ProviderTurnEntry, message: RpcMessage): void {
  const id = asString(asRecordOrEmpty(asRecordOrEmpty(message.params).turn).id)
  if (!id) return
  const turn = new CodexProviderTurn(id, entry)
  entry.providerTurn = turn
  entry.released = turn.released
  for (const event of turn.events.ingest(message)) turn.push(event)
}
