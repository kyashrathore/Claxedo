import { randomUUID } from "node:crypto"
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { SteerResult } from "@claxedo/agent-runtime-contract"

function sdkInputMessage(text: string): SDKUserMessage {
  return { type: "user", session_id: "", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null }
}

type Pending = { ids: Set<string>; resolve: (result: SteerResult) => void }

export class ClaudeTurnInput {
  private readonly queue: SDKUserMessage[]
  private readonly waiters: Array<() => void> = []
  private readonly pending = new Set<Pending>()
  private ended = false

  constructor(opening: string) { this.queue = [sdkInputMessage(opening)] }

  readonly stream: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: async function* (this: ClaudeTurnInput) {
      while (true) {
        const next = this.queue.shift()
        if (next) { yield next; continue }
        if (this.ended) return
        await new Promise<void>((resolve) => this.waiters.push(resolve))
      }
    }.bind(this),
  }

  steer(text: string): Promise<SteerResult> {
    if (this.ended) return Promise.resolve({ ok: false, status: "no_active_turn", message: "Claude turn ended" })
    const message = { ...sdkInputMessage(text), uuid: randomUUID() }
    const result = new Promise<SteerResult>((resolve) => this.pending.add({ ids: new Set([message.uuid]), resolve }))
    this.queue.push(message)
    this.wake()
    return result
  }

  observe(message: SDKMessage): boolean {
    if (message.type !== "user" || !("isReplay" in message) || !message.isReplay) return false
    for (const item of this.pending) {
      if (!item.ids.delete(message.uuid) || item.ids.size) continue
      this.pending.delete(item)
      item.resolve({ ok: true })
    }
    return true
  }

  close(): void {
    this.ended = true
    this.wake()
  }

  settle(outcome: "ended" | "failed"): void {
    this.close()
    for (const item of this.pending) item.resolve({ ok: false, status: outcome === "ended" ? "declined" : "unknown", message: "Claude did not replay the steer" })
    this.pending.clear()
  }

  private wake(): void { for (const resolve of this.waiters.splice(0)) resolve() }
}
