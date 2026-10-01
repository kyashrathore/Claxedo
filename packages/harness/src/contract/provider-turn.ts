import { AsyncPushQueue } from "@claxedo/helpers"
import type { ProviderTurnResult, ProviderTurnSettlement, SessionBroker, TurnBroker } from "./broker"
import type { RoutedEvent, TurnRef } from "./session"

export type QueuedProviderTurnHooks = {
  started(turnBroker: TurnBroker, turn: TurnRef): void
  ended(turnBroker: TurnBroker): void
  refused(): void
  settled(settlement: ProviderTurnSettlement): void
}

export type QueuedProviderTurn = { queue: AsyncPushQueue<RoutedEvent>; admission: Promise<ProviderTurnResult> }

export function admitQueuedProviderTurn(broker: SessionBroker, hooks: QueuedProviderTurnHooks): QueuedProviderTurn {
  const queue = new AsyncPushQueue<RoutedEvent>()
  const objective = broker.goal.read()?.objective
  const admission = broker.admitProviderTurn({ reason: "goal", ...(objective ? { detail: objective } : {}) }, async function* (turnBroker, turn) {
    hooks.started(turnBroker, turn)
    try { for await (const event of queue) yield event }
    finally { hooks.ended(turnBroker) }
  })
  void admission.then((result) => {
    if (!result.admitted) { queue.end(); hooks.refused(); return }
    void result.settled.then((settlement) => hooks.settled(settlement))
  }, (error: unknown) => {
    queue.fail(error)
    hooks.refused()
    broker.reportFailure(error)
  })
  return { queue, admission }
}
