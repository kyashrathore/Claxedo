import type { SteerResult } from "@claxedo/agent-runtime-contract"
import type { RoutedEvent } from "../../contract"
import { TransportError } from "../../contract/errors"
import { piUserText } from "./events"
import type { PiMessage } from "./rpc"

type Steer = { messageId: string; text: string }

export class PiSteers {
  private readonly pending: Steer[] = []
  private promptTaken = false

  add(steer: Steer): () => void {
    this.pending.push(steer)
    return () => {
      const index = this.pending.indexOf(steer)
      if (index >= 0) this.pending.splice(index, 1)
    }
  }

  incorporated(message: PiMessage): RoutedEvent | undefined {
    const text = piUserText(message)
    if (text === undefined) return undefined
    if (!this.promptTaken) {
      this.promptTaken = true
      return undefined
    }
    if (this.pending[0]?.text !== text) return undefined
    const steer = this.pending.shift()!
    return { event: { type: "input-incorporated", messageId: steer.messageId }, source: { dir: "in", method: "message_start" } }
  }
}

export function piSteerResult(disposition: unknown, withdraw: () => void): SteerResult {
  if (disposition === "queued") return { ok: true }
  withdraw()
  if (disposition === "handled") return { ok: false, status: "declined", message: "A Pi extension took the steer as input, so it is not in the conversation" }
  throw new TransportError("pi", "protocol", `Pi answered a steer with disposition ${String(disposition)}`)
}
