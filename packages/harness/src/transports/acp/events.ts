import { createAgentEventRuntime } from "@claxedo/agent-event-runtime"
import { createAcpEventTranslator } from "@claxedo/agent-event-runtime/harnesses/acp"
import type { SessionNotification } from "@agentclientprotocol/sdk"
import type { HarnessSession, RoutedEvent } from "../../contract"
import { AcpQueue } from "./queue"
import type { AcpEntry } from "./index"
import { unrecognizedEvent } from "../../translate/unrecognized"
import { acpSubagentObservation, supportsAcpSubagents } from "./extensions/subagents"

export function acpReceiver(harnessId: string, session: HarnessSession, queue: AcpQueue<RoutedEvent>): (notification: SessionNotification) => void {
  const runtimes = new Map<string, ReturnType<typeof createAgentEventRuntime>>()
  return (notification) => {
    let runtime = runtimes.get(notification.sessionId)
    if (!runtime) {
      runtime = createAgentEventRuntime({ harness: harnessId, threadId: notification.sessionId,
        adapter: createAcpEventTranslator({ client: harnessId }) })
      runtimes.set(notification.sessionId, runtime)
    }
    const result = runtime.ingest({ source: "acp.jsonrpc", method: "session/update", payload: notification.update })
    for (const event of result.events) queue.push({ event,
      route: notification.sessionId === session.binding.upstreamSessionId ? { kind: "parent" } : { kind: "child", correlationKey: notification.sessionId },
      source: { dir: "in", method: "session/update" } })
  }
}

export async function acpUpdate(entry: AcpEntry | undefined, notification: SessionNotification,
  observe: (update: SessionNotification["update"]) => Promise<void>): Promise<void> {
  if (!entry) return
  if (notification.update.sessionUpdate === "available_commands_update") {
    entry.commands = notification.update.availableCommands.map((item) => ({ name: item.name, description: item.description }))
  }
  if (notification.update.sessionUpdate === "config_option_update") entry.options = notification.update.configOptions
  await observe(notification.update)
  entry.quiet?.touch()
  if (entry.receive) entry.receive(notification)
  else {
    const runtime = createAgentEventRuntime({ harness: entry.start.config.harness.id, threadId: notification.sessionId,
      adapter: createAcpEventTranslator({ client: entry.start.config.harness.id }) })
    const result = runtime.ingest({ source: "acp.jsonrpc", method: "session/update", payload: notification.update })
    for (const event of result.events) {
      if (event.type === "available-commands-update" || event.type === "config-update" || event.type === "session-info" ||
        event.type === "session-title" || event.type === "session-agent" || event.type === "diagnostic") await entry.broker.publish(event)
    }
  }
}

export async function acpUnknown(entry: AcpEntry | undefined, sessionId: string, method: string, payload: unknown): Promise<void> {
  if (!entry || (entry.session.binding.upstreamSessionId && entry.session.binding.upstreamSessionId !== sessionId)) return
  const event = unrecognizedEvent("acp.jsonrpc", method, payload)
  if (entry.queue) entry.queue.push({ event })
  else await entry.broker.publish(event)
}

export async function acpObserveSubagent(entry: AcpEntry | undefined, update: unknown): Promise<void> {
  if (!entry?.turnBroker || !supportsAcpSubagents(entry.peer.handshake)) return
  const child = acpSubagentObservation(update)
  if (!child) return
  const ref = await entry.turnBroker.observeSubagent(child.observation)
  if (ref) entry.turnBroker.associateChild(child.key, ref)
}
