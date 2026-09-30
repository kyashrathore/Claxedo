import { asRecordOrEmpty, asString } from "@claxedo/helpers/guards"
import type { HarnessSession, RoutedEvent, SessionBroker, TurnBroker } from "../../contract"
import { admitQueuedProviderTurn } from "../../contract"
import { CodexEvents } from "./events"
import type { AsyncPushQueue } from "@claxedo/helpers"
import { CodexTransportError } from "./errors"
import type { RpcMessage } from "./rpc"
import type { CodexUsageLedger } from "./usage"

export type CodexProviderTurn = { id: string; queue: AsyncPushQueue<RoutedEvent>; events: CodexEvents; turnBroker?: TurnBroker }
export type ProviderTurnEntry = { session: HarnessSession; broker: SessionBroker; usage: CodexUsageLedger; providerTurn?: CodexProviderTurn; idle(): void }

export function admitCodexProviderTurn(entry: ProviderTurnEntry, message: RpcMessage): void {
  const id = asString(asRecordOrEmpty(asRecordOrEmpty(message.params).turn).id)
  if (!id) return
  const events = new CodexEvents(entry.session.binding.upstreamSessionId)
  const clear = () => { if (entry.providerTurn === providerTurn) entry.providerTurn = undefined }
  const { queue } = admitQueuedProviderTurn(entry.broker, {
    started: (turnBroker, turn) => {
      providerTurn.turnBroker = turnBroker
      entry.usage.attach({ sessionId: entry.session.binding.sessionId, directory: entry.session.directory, assistantMessageId: turn.assistantMessageId })
    },
    ended: () => {},
    refused: clear,
    settled: (settlement) => {
      if (settlement.state === "failed") entry.broker.reportFailure(new CodexTransportError("session", settlement.error))
      if (settlement.state !== "completed") { queue.end(); clear() }
      entry.idle()
    },
  })
  const providerTurn: CodexProviderTurn = { id, queue, events }
  entry.providerTurn = providerTurn
  for (const event of events.ingest(message)) queue.push(event)
}
