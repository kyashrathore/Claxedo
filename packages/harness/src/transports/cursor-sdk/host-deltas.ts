import type { InteractionUpdate, SDKMessage } from "@cursor/sdk"
import type { HostDelta } from "./protocol"

type Streamed = { kind: "event"; message: SDKMessage } | { kind: "delta"; update: HostDelta }

export function forwardedDelta(update: InteractionUpdate): HostDelta | undefined {
  return update.type === "shell-output-delta" || update.type === "tool-call-delta" ? update : undefined
}

export class HostDeltaOrder {
  private readonly announced = new Set<string>()
  private readonly held = new Map<string, HostDelta[]>()

  constructor(private readonly post: (reply: Streamed) => void) {}

  message(message: SDKMessage): void {
    this.post({ kind: "event", message })
    if (message.type !== "tool_call" || this.announced.has(message.call_id)) return
    this.announced.add(message.call_id)
    for (const update of this.held.get(message.call_id) ?? []) this.post({ kind: "delta", update })
    this.held.delete(message.call_id)
  }

  delta(update: HostDelta): void {
    if (update.type === "tool-call-delta" && !this.announced.has(update.callId)) {
      this.held.set(update.callId, [...this.held.get(update.callId) ?? [], update])
      return
    }
    this.post({ kind: "delta", update })
  }

  end(): void {
    for (const updates of this.held.values()) for (const update of updates) this.post({ kind: "delta", update })
    this.held.clear()
  }
}
