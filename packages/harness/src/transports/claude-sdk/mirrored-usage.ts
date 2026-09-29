import type { SessionBroker } from "../../contract"
import type { claudeTranslator } from "./events"

export type MirroredRequest = { upstreamSessionId: string; id: string; usage: Record<string, unknown>; model?: string }

type Target = { broker: SessionBroker; assistantMessageId: string; directory: string }

export class ClaudeMirroredUsage {
  private held: MirroredRequest[] | undefined = []

  constructor(private readonly runtime: ReturnType<typeof claudeTranslator>["runtime"], private readonly target: Target) {}

  observe(request: MirroredRequest): void {
    if (this.held) this.held.push(request)
    else this.meter(request)
  }

  release(): void {
    const held = this.held ?? []
    this.held = undefined
    for (const request of held) this.meter(request)
  }

  private meter(request: MirroredRequest): void {
    const { broker, assistantMessageId, directory } = this.target
    const events = this.runtime.ingest({ source: "claude.sdk", method: "claude/subagent-usage", payload: {
      parent_tool_use_id: null, session_id: request.upstreamSessionId,
      message: { id: request.id, usage: request.usage, ...(request.model ? { model: request.model } : {}) },
    } }).events
    for (const event of events) if (event.type === "usage") broker.meter({ sessionId: broker.sessionId, directory, assistantMessageId, usage: event })
  }
}
