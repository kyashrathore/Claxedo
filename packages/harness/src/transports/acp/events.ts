import { applyAcpGoal, receiveAcpProviderUpdate } from "./provider-turn"
import { goalSnapshot } from "./extensions/goals"
import { createAgentEventRuntime } from "../../translate/runtime"
import { createAcpEventTranslator } from "./translate/event-translator"
import type { SessionNotification } from "@agentclientprotocol/sdk"
import type { RuntimeGoalSnapshot } from "@claxedo/agent-runtime-contract"
import type { HarnessSession, RoutedEvent } from "../../contract"
import { AsyncPushQueue } from "@claxedo/helpers"
import type { AcpEntry } from "./index"
import { acpKeptPermissionMode } from "./options"
import { unrecognizedEvent } from "../../translate/unrecognized"
import { routedIngest } from "../../translate/ingest"
import { supportsAcpSubagents } from "./extensions/subagents"

export function acpReceiver(harnessId: string, session: HarnessSession, queue: AsyncPushQueue<RoutedEvent>): (notification: SessionNotification) => void {
  const runtime = createAgentEventRuntime({ harness: harnessId, threadId: session.binding.upstreamSessionId,
    adapter: createAcpEventTranslator({ client: harnessId }) })
  return (notification) => {
    for (const event of routedIngest(runtime, { source: "acp.jsonrpc", method: "session/update", payload: notification.update }, {
      method: "session/update", target: { kind: "parent" },
    })) queue.push(event)
  }
}

export async function acpUpdate(entry: AcpEntry | undefined, notification: SessionNotification): Promise<void> {
  if (!entry) return
  if (entry.pendingUpdates) {
    entry.pendingUpdates.push(notification)
    return
  }
  await deliverAcpUpdate(entry, notification)
}

export async function acpFlushUpdates(entry: AcpEntry): Promise<void> {
  const pending = entry.pendingUpdates
  if (!pending) return
  while (pending.length) await deliverAcpUpdate(entry, pending.shift()!)
  entry.pendingUpdates = undefined
  await entry.start.permissionModeKept?.(acpKeptPermissionMode(entry))
}

export async function acpReportModeMove(entry: AcpEntry, change: () => Promise<void> | void): Promise<void> {
  const before = acpKeptPermissionMode(entry)
  await change()
  const after = acpKeptPermissionMode(entry)
  if (after.modeId !== before.modeId || after.label !== before.label) await entry.start.permissionModeKept?.(after)
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

async function deliverAcpUpdate(entry: AcpEntry, notification: SessionNotification): Promise<void> {
  const side = entry.sideSessions.get(notification.sessionId)
  if (side) { side(notification.update); return }
  if (notification.sessionId !== entry.session.binding.upstreamSessionId) {
    await acpObserveSubagent(entry, notification.update)
    entry.quiet?.touch()
    await entry.children.deliver(notification)
    return
  }
  const meta = notification.update._meta?.goal
  const goal = meta === undefined ? undefined : goalSnapshot(entry.session.binding.sessionId, { goal: meta })
  await acpReportModeMove(entry, () => acpCatalogUpdate(entry, notification.update))
  const deliver = async () => {
    await acpObserveSubagent(entry, notification.update)
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
  if (!entry || !supportsAcpSubagents(entry.peer.handshake)) return
  await entry.children.observe(update, entry.turnBroker ?? entry.broker)
}
