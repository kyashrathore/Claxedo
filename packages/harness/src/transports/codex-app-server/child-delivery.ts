import type { AsyncPushQueue } from "@claxedo/helpers"
import type { RoutedEvent, SessionBroker } from "../../contract"
import type { CodexChild } from "./children"
import type { CodexProviderTurn } from "./provider-turn"
import type { RpcMessage } from "./rpc"

export type ChildDeliveryEntry = {
  broker: Pick<SessionBroker, "publishChild">
  turn?: { queue: AsyncPushQueue<RoutedEvent>; closing?: boolean }
  providerTurn?: CodexProviderTurn
  released: Promise<void>
}

type LiveTurn = { push(event: RoutedEvent): void; delivered(): Promise<void> }

function liveTurn(entry: ChildDeliveryEntry): LiveTurn | undefined {
  const turn = entry.turn
  if (turn && !turn.closing) return { push: (event) => turn.queue.push(event), delivered: () => turn.queue.drained() }
  const provider = entry.providerTurn
  return provider && { push: (event) => provider.push(event), delivered: () => provider.delivered() }
}

export async function deliverChildFrame(entry: ChildDeliveryEntry, child: CodexChild, message: RpcMessage): Promise<void> {
  const events = child.translate(message)
  if (!events.length) return
  const live = liveTurn(entry)
  if (live) {
    for (const event of events) live.push(event)
    return
  }
  await entry.released
  for (const event of events) await entry.broker.publishChild(event)
}

export function childFramesDelivered(entry: ChildDeliveryEntry): Promise<void> {
  return liveTurn(entry)?.delivered() ?? Promise.resolve()
}
