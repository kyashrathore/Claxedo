import type { Clock } from "../../contract"
import { CodexRequestRefusal } from "./errors"
import type { RpcMessage } from "./rpc"

type Held = { threadId: string; deliver(): void; drop(reason: Error): void; bytes: number; timer: unknown }

const MAX_FRAMES = 256
const MAX_BYTES = 1_048_576

export class CodexEarlyFrames {
  private readonly held = new Set<Held>()
  private bytes = 0

  constructor(private readonly clock: Clock, private readonly expiryMs = 10_000) {}

  hold(threadId: string, message: RpcMessage, deliver: () => void, drop: (reason: Error) => void): (reason: Error) => void {
    const bytes = Buffer.byteLength(JSON.stringify(message))
    if (this.held.size >= MAX_FRAMES || this.bytes + bytes > MAX_BYTES) {
      drop(new CodexRequestRefusal(-32000, `Codex frames for threads without an owner exceeded ${MAX_FRAMES} frames or ${MAX_BYTES} bytes`))
      return () => undefined
    }
    const frame: Held = { threadId, deliver, drop, bytes, timer: undefined }
    frame.timer = this.clock.setTimeout(() => this.release(frame, new CodexRequestRefusal(-32000, `Codex thread ${threadId} has no owner`)), this.expiryMs)
    this.held.add(frame)
    this.bytes += bytes
    return (reason) => this.release(frame, reason)
  }

  claim(threadId: string): void {
    for (const frame of this.held) {
      if (frame.threadId !== threadId) continue
      this.remove(frame)
      frame.deliver()
    }
  }

  clear(reason: Error): void {
    for (const frame of this.held) this.release(frame, reason)
  }

  private release(frame: Held, reason: Error): void {
    if (!this.held.has(frame)) return
    this.remove(frame)
    frame.drop(reason)
  }

  private remove(frame: Held): void {
    this.clock.clearTimeout(frame.timer)
    this.held.delete(frame)
    this.bytes -= frame.bytes
  }
}
