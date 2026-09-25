import { createAgentEventRuntime } from "@claxedo/agent-event-runtime"
import { codexAppServerAdapter } from "@claxedo/agent-event-runtime/harnesses/codex"
import type { RoutedEvent } from "../../contract"
import type { RpcMessage } from "./rpc"

export class CodexEvents {
  private readonly runtime
  constructor(threadId: string) {
    this.runtime = createAgentEventRuntime({ harness: "codex", threadId, adapter: codexAppServerAdapter() })
  }
  ingest(message: RpcMessage): RoutedEvent[] {
    if (!message.method) return []
    return this.runtime.ingest({ source: "codex.app-server", method: message.method, payload: message.params }).events
      .map((event) => ({ event, source: { dir: "in" as const, method: message.method! } }))
  }
}

export class CodexEventQueue<T> {
  private readonly values: T[] = []
  private waiter?: { resolve(result: IteratorResult<T>): void; reject(error: unknown): void }
  private state: { kind: "open" } | { kind: "ended" } | { kind: "failed"; error: unknown } = { kind: "open" }
  push(value: T): void {
    if (this.state.kind !== "open") return
    if (this.waiter) { this.waiter.resolve({ done: false, value }); this.waiter = undefined }
    else this.values.push(value)
  }
  end(): void {
    this.state = { kind: "ended" }
    if (this.waiter) { this.waiter.resolve({ done: true, value: undefined }); this.waiter = undefined }
  }
  fail(error: unknown): void {
    this.state = { kind: "failed", error }
    if (this.waiter) { this.waiter.reject(error); this.waiter = undefined }
  }
  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift()
    if (value !== undefined) return Promise.resolve({ done: false, value })
    if (this.state.kind === "failed") return Promise.reject(this.state.error)
    if (this.state.kind === "ended") return Promise.resolve({ done: true, value: undefined })
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject } })
  }
}
