import { asRecordOrEmpty, asString } from "@claxedo/helpers/guards"
import type { HarnessSession, RoutedEvent, SessionBroker, TurnBroker } from "../../contract"
import { CodexEvents } from "./events"
import { AsyncPushQueue } from "@claxedo/helpers"
import { CodexTransportError } from "./errors"
import type { RpcMessage } from "./rpc"

export type CodexProviderTurn = { id: string; queue: AsyncPushQueue<RoutedEvent>; events: CodexEvents; turnBroker?: TurnBroker }
export type ProviderTurnEntry = { session: HarnessSession; broker: SessionBroker; providerTurn?: CodexProviderTurn }

export function admitCodexProviderTurn(entry: ProviderTurnEntry, message: RpcMessage): void {
  const id = asString(asRecordOrEmpty(asRecordOrEmpty(message.params).turn).id)
  if (!id) return
  const queue = new AsyncPushQueue<RoutedEvent>()
  const providerTurn: CodexProviderTurn = { id, queue, events: new CodexEvents(entry.session.binding.upstreamSessionId) }
  entry.providerTurn = providerTurn
  for (const event of providerTurn.events.ingest(message)) queue.push(event)
  void entry.broker.admitProviderTurn({ reason: "goal" }, async function* (turnBroker) {
    providerTurn.turnBroker = turnBroker
    for (;;) {
      const next = await queue.next()
      if (next.done) return
      yield next.value
    }
  }).then((result) => {
    if (!result.admitted) { queue.end(); entry.providerTurn = undefined }
    else void result.settled.then((settlement) => {
      if (settlement.state === "failed") entry.broker.reportFailure(new CodexTransportError("session", settlement.error))
      if (settlement.state !== "completed") { queue.end(); entry.providerTurn = undefined }
    })
  }, (error: unknown) => { queue.fail(error); entry.broker.reportFailure(error) })
}
