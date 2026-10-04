import type { TurnAccount } from "@claxedo/agent-runtime-contract"
import type { RoutedEvent } from "../contract"

export async function* withTurnAccount(events: AsyncIterable<RoutedEvent>, account: TurnAccount | undefined): AsyncIterable<RoutedEvent> {
  for await (const routed of events) {
    yield account && routed.event.type === "error" && routed.route?.kind !== "child"
      ? { ...routed, event: { ...routed.event, account } }
      : routed
  }
}
