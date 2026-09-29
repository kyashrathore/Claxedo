import { randomUUID } from "node:crypto"
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { SteerResult } from "@claxedo/agent-runtime-contract"
import { AsyncPushQueue } from "@claxedo/helpers"

type Pending = { uuid: string; messageId: string; resolve: (result: SteerResult) => void }

export class ClaudeQueryInput {
  private readonly queue = new AsyncPushQueue<SDKUserMessage>()
  private readonly pending = new Set<Pending>()
  private steerable = false

  readonly stream: AsyncIterable<SDKUserMessage> = this.queue

  open(message: SDKUserMessage): void {
    this.steerable = true
    this.queue.push(message)
  }

  steer(input: SDKUserMessage, messageId: string): Promise<SteerResult> {
    if (!this.steerable) return Promise.resolve({ ok: false, status: "no_active_turn", message: "Claude turn ended" })
    const message = { ...input, uuid: randomUUID() }
    const result = new Promise<SteerResult>((resolve) => this.pending.add({ uuid: message.uuid, messageId, resolve }))
    this.queue.push(message)
    return result
  }

  observe(message: SDKMessage): string[] | undefined {
    if (message.type !== "user" || !("isReplay" in message) || !message.isReplay) return undefined
    const incorporated: string[] = []
    for (const item of this.pending) {
      if (item.uuid !== message.uuid) continue
      this.pending.delete(item)
      item.resolve({ ok: true })
      incorporated.push(item.messageId)
    }
    return incorporated
  }

  endTurn(): void {
    this.steerable = false
  }

  close(): void {
    this.steerable = false
    this.queue.end()
  }

  settle(outcome: "ended" | "failed"): void {
    this.steerable = false
    for (const item of this.pending) item.resolve({ ok: false, status: outcome === "ended" ? "declined" : "unknown", message: "Claude did not replay the steer" })
    this.pending.clear()
  }
}
