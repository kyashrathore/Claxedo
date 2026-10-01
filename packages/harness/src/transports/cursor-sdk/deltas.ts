import type { RoutedEvent } from "../../contract"
import { routedIngest } from "../../translate/ingest"
import { createAgentEventRuntime } from "../../translate/runtime"
import type { HostDelta } from "./protocol"
import { cursorSdkAdapter, nestedTaskMessage } from "./translate"

type Runtime = ReturnType<typeof createAgentEventRuntime>

export class CursorDeltaRoutes {
  private readonly children = new Map<string, Runtime>()

  constructor(private readonly parent: Runtime) {}

  events(update: HostDelta): RoutedEvent[] {
    if (update.type === "shell-output-delta") {
      return routedIngest(this.parent, { source: "cursor.sdk.delta", method: "cursor/shell-output-delta", payload: update },
        { method: "cursor.shell-output-delta", target: { kind: "parent" } })
    }
    const message = nestedTaskMessage(update.taskUpdate, update.callId)
    if (!message) return []
    return routedIngest(this.child(update.callId), { source: "cursor.sdk.message", method: `cursor/${message.type}`, payload: message },
      { method: `cursor.task.${message.type}`, target: { kind: "child", correlationKey: update.callId } })
  }

  private child(taskCallId: string): Runtime {
    const existing = this.children.get(taskCallId)
    if (existing) return existing
    const runtime = createAgentEventRuntime({ harness: "cursor", threadId: taskCallId, adapter: cursorSdkAdapter() })
    this.children.set(taskCallId, runtime)
    return runtime
  }
}
