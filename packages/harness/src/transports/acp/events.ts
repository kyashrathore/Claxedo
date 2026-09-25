import { createAgentEventRuntime } from "@claxedo/agent-event-runtime"
import { createAcpEventTranslator } from "@claxedo/agent-event-runtime/harnesses/acp"
import type { SessionNotification } from "@agentclientprotocol/sdk"
import type { HarnessSession, RoutedEvent } from "../../contract"
import { AcpQueue } from "./queue"

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
