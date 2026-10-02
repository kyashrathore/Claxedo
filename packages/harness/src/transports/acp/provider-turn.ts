import type { AsyncPushQueue } from "@claxedo/helpers"
import type { RuntimeGoalSnapshot } from "@claxedo/agent-runtime-contract"
import type { SessionNotification } from "@agentclientprotocol/sdk"
import { admitQueuedProviderTurn, type ProviderTurnResult, type RoutedEvent } from "../../contract"
import type { AcpEntry } from "./index"
import { acpReceiver } from "./events"
import { acpCancelDeadline, trackedAcpCancel } from "./cancellation"
import { AcpTransportError } from "./errors"
import { acpUsageUnavailable } from "./usage"

export type AcpProviderTurn = {
  queue: AsyncPushQueue<RoutedEvent>
  receive: (notification: SessionNotification) => void
  admission: Promise<ProviderTurnResult>
}

const PROVIDER_UPDATES = ["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan", "usage_update"]

export async function receiveAcpProviderUpdate(entry: AcpEntry, notification: SessionNotification, goalActive: boolean): Promise<boolean> {
  if (!entry.providerTurn && (!goalActive || !PROVIDER_UPDATES.includes(notification.update.sessionUpdate))) return false
  const provider = entry.providerTurn ?? admitAcpProviderTurn(entry)
  provider.receive(notification)
  const admitted = await provider.admission
  if (!admitted.admitted) {
    await trackedAcpCancel(entry, acpCancelDeadline())
    throw new AcpTransportError("session", `ACP autonomous turn refused: ${admitted.reason}`)
  }
  return true
}

function admitAcpProviderTurn(entry: AcpEntry): AcpProviderTurn {
  entry.cancelled = false
  entry.cancelSent = undefined
  let aborted = () => {}
  const turn = admitQueuedProviderTurn(entry.broker, {
    started: (broker) => {
      entry.turnBroker = broker
      aborted = () => {
        void trackedAcpCancel(entry, acpCancelDeadline())
        turn.queue.fail(new AcpTransportError("session", "ACP autonomous turn cancelled"))
      }
      broker.signal.addEventListener("abort", aborted, { once: true })
      if (broker.signal.aborted) aborted()
    },
    ended: (broker) => {
      broker.signal.removeEventListener("abort", aborted)
      if (entry.turnBroker === broker) entry.turnBroker = undefined
      if (entry.providerTurn === provider) entry.providerTurn = undefined
    },
    refused: () => { if (entry.providerTurn === provider) entry.providerTurn = undefined },
    settled: (settled) => {
      if (settled.state === "failed") entry.broker.reportFailure(new AcpTransportError("session", settled.error))
      entry.cancelSent = undefined
      entry.onIdle()
    },
  })
  const provider: AcpProviderTurn = { ...turn, receive: acpReceiver(entry.start.config.harness.id, entry.session, turn.queue) }
  entry.providerTurn = provider
  return provider
}

async function endAcpProviderTurn(entry: AcpEntry): Promise<void> {
  const provider = entry.providerTurn
  if (!provider) return
  entry.providerTurn = undefined
  provider.queue.push(acpUsageUnavailable("ACP carries no token usage for an autonomous Goal turn", "session/update"))
  provider.queue.push({ event: { type: "finish", sessionId: entry.session.binding.sessionId } })
  provider.queue.end()
  const result = await provider.admission
  if (result.admitted) await result.settled
}

function iterationAdvanced(previous: RuntimeGoalSnapshot | null, next: RuntimeGoalSnapshot | null): boolean {
  return previous?.iteration !== undefined && next?.iteration !== undefined && next.iteration > previous.iteration
}

export async function applyAcpGoal(entry: AcpEntry, goal: RuntimeGoalSnapshot | null, deliver: () => Promise<void> = async () => {}): Promise<void> {
  if (iterationAdvanced(entry.broker.goal.read(), goal)) await endAcpProviderTurn(entry)
  await deliver()
  await entry.broker.goal.publish(goal)
  if (goal?.status !== "active") await endAcpProviderTurn(entry)
}
