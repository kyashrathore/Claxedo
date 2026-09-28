import { applyAcpGoal, receiveAcpProviderUpdate } from "./provider-turn"
import { goalSnapshot } from "./extensions/goals"
import { createAgentEventRuntime } from "../../translate/runtime"
import { createAcpEventTranslator } from "./translate/event-translator"
import type { SessionNotification } from "@agentclientprotocol/sdk"
import type { RuntimeGoalSnapshot } from "@claxedo/agent-runtime-contract"
import type { HarnessSession, RoutedEvent } from "../../contract"
import { AsyncPushQueue } from "@claxedo/helpers"
import type { AcpEntry } from "./index"
import { unrecognizedEvent } from "../../translate/unrecognized"
import { routedIngest } from "../../translate/ingest"
import { acpSubagentObservation, supportsAcpSubagents } from "./extensions/subagents"

export function acpReceiver(harnessId: string, session: HarnessSession, queue: AsyncPushQueue<RoutedEvent>): (notification: SessionNotification) => void {
  const runtimes = new Map<string, ReturnType<typeof createAgentEventRuntime>>()
  return (notification) => {
    let runtime = runtimes.get(notification.sessionId)
    if (!runtime) {
      runtime = createAgentEventRuntime({ harness: harnessId, threadId: notification.sessionId,
        adapter: createAcpEventTranslator({ client: harnessId }) })
      runtimes.set(notification.sessionId, runtime)
    }
    for (const event of routedIngest(runtime, { source: "acp.jsonrpc", method: "session/update", payload: notification.update }, {
      method: "session/update",
      target: notification.sessionId === session.binding.upstreamSessionId ? { kind: "parent" } : { kind: "child", correlationKey: notification.sessionId },
    })) queue.push(event)
  }
}

export async function acpUpdate(entry: AcpEntry | undefined, notification: SessionNotification,
  observe: (update: SessionNotification["update"]) => Promise<void>): Promise<void> {
  if (!entry) return
  if (entry.pendingUpdates) {
    entry.pendingUpdates.push(notification)
    return
  }
  await deliverAcpUpdate(entry, notification, observe)
}

export async function acpFlushUpdates(entry: AcpEntry,
  observe: (update: SessionNotification["update"]) => Promise<void>): Promise<void> {
  const pending = entry.pendingUpdates
  if (!pending) return
  while (pending.length) await deliverAcpUpdate(entry, pending.shift()!, observe)
  entry.pendingUpdates = undefined
}

function acpCatalogUpdate(entry: AcpEntry, update: SessionNotification["update"]): void {
  if (update.sessionUpdate === "available_commands_update") {
    entry.commands = update.availableCommands.map((item) => ({ name: item.name, description: item.description }))
  }
  if (update.sessionUpdate === "config_option_update") entry.options = update.configOptions
  if (update.sessionUpdate === "current_mode_update") { entry.currentModeId = update.currentModeId; entry.modeUpdates++ }
  if (update.sessionUpdate === "usage_update") entry.context = { size: update.size, used: update.used }
}

async function ingestAcpUpdate(entry: AcpEntry, notification: SessionNotification, goal: RuntimeGoalSnapshot | null | undefined): Promise<void> {
  if (entry.receive) { entry.receive(notification); return }
  const goalActive = entry.broker.goal.read()?.status === "active" || goal?.status === "active"
  if (await receiveAcpProviderUpdate(entry, notification, goalActive)) return
  const runtime = createAgentEventRuntime({ harness: entry.start.config.harness.id, threadId: notification.sessionId,
    adapter: createAcpEventTranslator({ client: entry.start.config.harness.id }) })
  const routed = routedIngest(runtime, { source: "acp.jsonrpc", method: "session/update", payload: notification.update }, { method: "session/update" })
  for (const item of routed) {
    const event = item.event
    if (event.type === "available-commands-update" || event.type === "config-update" || event.type === "session-info" ||
      event.type === "session-title" || event.type === "session-agent" || event.type === "diagnostic") await entry.broker.publish(event)
  }
}

async function deliverAcpUpdate(entry: AcpEntry, notification: SessionNotification,
  observe: (update: SessionNotification["update"]) => Promise<void>): Promise<void> {
  const side = entry.sideSessions.get(notification.sessionId)
  if (side) { side(notification.update); return }
  if (notification.sessionId !== entry.session.binding.upstreamSessionId) {
    await observe(notification.update)
    entry.quiet?.touch()
    const receive = entry.receive ?? entry.providerTurn?.receive
    receive?.(notification)
    return
  }
  const meta = notification.update._meta?.goal
  const goal = meta === undefined ? undefined : goalSnapshot(entry.session.binding.sessionId, { goal: meta })
  acpCatalogUpdate(entry, notification.update)
  const deliver = async () => {
    await observe(notification.update)
    entry.quiet?.touch()
    await ingestAcpUpdate(entry, notification, goal)
  }
  if (goal === undefined) await deliver()
  else await applyAcpGoal(entry, goal, deliver)
}

export async function acpUnknown(entry: AcpEntry | undefined, sessionId: string, method: string, payload: unknown): Promise<void> {
  if (!entry || (entry.session.binding.upstreamSessionId && entry.session.binding.upstreamSessionId !== sessionId)) return
  const event = unrecognizedEvent("acp.jsonrpc", method, payload)
  const queue = entry.queue ?? entry.providerTurn?.queue
  if (queue) queue.push({ event })
  else await entry.broker.publish(event)
}

export async function acpObserveSubagent(entry: AcpEntry | undefined, update: unknown): Promise<void> {
  if (!entry?.turnBroker || !supportsAcpSubagents(entry.peer.handshake)) return
  const child = acpSubagentObservation(update)
  if (!child) return
  const ref = await entry.turnBroker.observeSubagent(child.observation)
  if (ref) entry.turnBroker.associateChild(child.key, ref)
}
