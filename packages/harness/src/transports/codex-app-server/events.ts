import { createAgentEventRuntime } from "@claxedo/agent-event-runtime"
import { codexAppServerAdapter } from "@claxedo/agent-event-runtime/harnesses/codex"
import type { RoutedEvent, SessionBroker } from "../../contract"
import type { RpcMessage } from "./rpc"
import { unrecognizedEvent } from "../../translate/unrecognized"
import { routedIngest } from "../../translate/ingest"

export class CodexEvents {
  private readonly runtime
  constructor(threadId: string) {
    this.runtime = createAgentEventRuntime({ harness: "codex", threadId, adapter: codexAppServerAdapter() })
  }
  ingest(message: RpcMessage): RoutedEvent[] {
    if (!message.method) return []
    return routedIngest(this.runtime, { source: "codex.app-server", method: message.method, payload: message.params }, {
      method: message.method, mapEvent: (event) => event.type === "diagnostic" && event.diagnostic.code === "codex_app_server.unmapped_event"
        ? unrecognizedEvent("codex.app-server", message.method!, message.params) : event,
    })
  }
}

export async function publishCodexQuota(broker: Pick<SessionBroker, "publish">, threadId: string,
  message: RpcMessage): Promise<void> {
  for (const item of new CodexEvents(threadId).ingest(message)) {
    if (item.event.type === "rate-limit") await broker.publish(item.event)
  }
}
