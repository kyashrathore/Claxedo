import type { RuntimeGoalSnapshot } from "@claxedo/agent-runtime-contract"
import type { ProviderTurnInput, ProviderTurnResult, TurnBroker } from "../../contract/broker"
import type { RoutedEvent, TurnRef } from "../../contract/session"
import type { BrokerPorts } from "../ports"

export function goalPort(ports: BrokerPorts, sessionId: string) {
  return {
    read(): RuntimeGoalSnapshot | null {
      return ports.readGoal(sessionId)
    },
    publish(snapshot: RuntimeGoalSnapshot | null): Promise<void> {
      if (snapshot && snapshot.sessionId !== sessionId) throw new Error("Goal belongs to another session")
      return ports.publishGoal(sessionId, snapshot)
    },
  }
}

export function admitProviderTurn(
  ports: BrokerPorts,
  sessionId: string,
  input: ProviderTurnInput,
  makeTurn: (turn: TurnRef, signal: AbortSignal) => TurnBroker,
  run: (broker: TurnBroker, turn: TurnRef) => AsyncIterable<RoutedEvent>,
): Promise<ProviderTurnResult> {
  return ports.admitProviderTurn(sessionId, input, async (turn, signal) => {
    const broker = makeTurn(turn, signal)
    for await (const event of run(broker, turn)) {
      await ports.drainProviderEvent(sessionId, turn, event)
    }
  })
}
