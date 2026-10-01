import { randomUUID } from "node:crypto"
import type { SDKActiveGoalMessage, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { SteerResult } from "@claxedo/agent-runtime-contract"
import { AsyncPushQueue } from "@claxedo/helpers"

type Pending = { uuid: string; messageId: string; resolve: (result: SteerResult) => void }

const DROPPED_COMMAND_STATES: readonly string[] = ["cancelled", "discarded", "refused"]

function droppedCommand(message: unknown): { uuid: string; state: string } | undefined {
  if (!message || typeof message !== "object") return undefined
  const frame = message as { type?: unknown; command_uuid?: unknown; state?: unknown }
  if (frame.type !== "command_lifecycle" || typeof frame.command_uuid !== "string" || typeof frame.state !== "string") return undefined
  return DROPPED_COMMAND_STATES.includes(frame.state) ? { uuid: frame.command_uuid, state: frame.state } : undefined
}

export class ClaudeQueryInput {
  private readonly queue = new AsyncPushQueue<SDKUserMessage>()
  private readonly pending = new Set<Pending>()
  private readonly unreplayed = new Set<string>()
  private steerable = false

  readonly stream: AsyncIterable<SDKUserMessage> = this.queue

  get replayed(): boolean { return this.unreplayed.size === 0 }

  open(message: SDKUserMessage): void {
    this.write(message)
  }

  steer(input: SDKUserMessage, messageId: string): Promise<SteerResult> {
    if (!this.steerable) return Promise.resolve({ ok: false, status: "no_active_turn", message: "Claude turn ended" })
    let resolve!: (result: SteerResult) => void
    const result = new Promise<SteerResult>((settle) => { resolve = settle })
    this.pending.add({ uuid: this.write(input), messageId, resolve })
    return result
  }

  acknowledge(message: SDKMessage | SDKActiveGoalMessage): void {
    if (message.type === "user" && "isReplay" in message && message.isReplay && message.uuid) this.unreplayed.delete(message.uuid)
    const dropped = droppedCommand(message)
    if (dropped) this.drop(dropped.uuid, dropped.state)
  }

  private drop(uuid: string, state: string): void {
    this.unreplayed.delete(uuid)
    for (const item of this.pending) {
      if (item.uuid !== uuid) continue
      this.pending.delete(item)
      item.resolve({ ok: false, status: "declined", message: `Claude ${state} the steer before taking it in` })
    }
  }

  private write(input: SDKUserMessage): string {
    const uuid = randomUUID()
    this.steerable = true
    this.unreplayed.add(uuid)
    this.queue.push({ ...input, uuid })
    return uuid
  }

  observe(message: SDKMessage): string[] | undefined {
    if (message.type !== "user" || !("isReplay" in message) || !message.isReplay) return undefined
    if (message.origin?.kind === "peer") return undefined
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
    this.unreplayed.clear()
    for (const item of this.pending) item.resolve({ ok: false, status: outcome === "ended" ? "declined" : "unknown", message: "Claude did not replay the steer" })
    this.pending.clear()
  }
}
