import type { TurnAccount } from "@claxedo/agent-runtime-contract"
import type { RoutedEvent } from "../contract"

function stamped(routed: RoutedEvent, account: TurnAccount): RoutedEvent {
  const { event } = routed
  const spent = event.type === "usage" || (event.type === "error" && routed.route?.kind !== "child")
  return spent ? { ...routed, event: { ...event, account } } : routed
}

export async function* withTurnAccount(events: AsyncIterable<RoutedEvent>, account: TurnAccount | undefined): AsyncIterable<RoutedEvent> {
  for await (const routed of events) yield account ? stamped(routed, account) : routed
}
