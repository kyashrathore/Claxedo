import type { OwnedProcess, HarnessServices, Deadline } from "../../contract"
import { asRecordOrEmpty, asString, assertRecord } from "@claxedo/helpers/guards"
import { CodexRequestRefusal, CodexTransportError, codexRpcError } from "./errors"

export type RpcMessage = { id?: string | number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } }
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timeout: unknown }

export function codexRetirementDeadline(services: HarnessServices): Deadline {
  return { at: services.clock.now() + 10_000, signal: new AbortController().signal }
}

export class CodexRpc {
  private buffer = ""
  private serial = 0
  private closed = false
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Set<(message: RpcMessage) => void>()
  private handler?: (message: RpcMessage) => Promise<unknown>
  private retirement?: Promise<void>

  constructor(readonly process: OwnedProcess, private readonly clock: HarnessServices["clock"]) {
    process.stdout.setEncoding("utf8")
    process.stdout.on("data", (chunk: string) => this.read(chunk))
    process.stdout.on("error", (error) => this.fail(error))
    void process.exited.then((status) => this.fail(new CodexTransportError("process", `Codex exited (${status.signal ?? status.code})`)))
  }

  onMessage(listener: (message: RpcMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onRequest(handler: (message: RpcMessage) => Promise<unknown>): void { this.handler = handler }

  async request(method: string, params?: unknown, ms = 30_000): Promise<unknown> {
    if (this.closed) throw new CodexTransportError("process", `Codex ${method} was not sent after process exit`)
    const id = ++this.serial
    return await new Promise((resolve, reject) => {
      const timeout = this.clock.setTimeout(() => {
        this.pending.delete(id)
        reject(new CodexTransportError("protocol", `Codex ${method} did not answer within ${ms}ms`))
      }, ms)
      this.pending.set(id, { resolve, reject, timeout })
      this.write({ id, method, params })
    })
  }

  notify(method: string, params?: unknown): void { this.write({ method, ...(params === undefined ? {} : { params }) }) }

  private write(message: RpcMessage): void {
    if (this.closed) throw new CodexTransportError("process", "Codex process exited")
    this.process.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private read(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const end = this.buffer.indexOf("\n")
      if (end < 0) return
      const line = this.buffer.slice(0, end).trim()
      this.buffer = this.buffer.slice(end + 1)
      if (!line) continue
      let message: RpcMessage
      try {
        const parsed: unknown = JSON.parse(line)
        const fields = assertRecord(parsed, "Codex JSON-RPC frame")
        const error = asRecordOrEmpty(fields.error)
        message = {
          ...(typeof fields.id === "number" || typeof fields.id === "string" ? { id: fields.id } : {}),
          ...(asString(fields.method) ? { method: asString(fields.method) } : {}),
          params: fields.params, result: fields.result,
          ...(typeof error.code === "number" && typeof error.message === "string" ? { error: { code: error.code, message: error.message } } : {}),
        }
      }
      catch (cause) { this.fail(new CodexTransportError("protocol", "Invalid Codex JSON-RPC frame", { cause })); return }
      this.receive(message)
    }
  }

  private receive(message: RpcMessage): void {
    if (typeof message.id === "number" && !message.method) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      this.clock.clearTimeout(pending.timeout)
      if (message.error) pending.reject(codexRpcError(message.error))
      else pending.resolve(message.result)
      return
    }
    if (message.method && message.id !== undefined) {
      void this.answer(message)
      return
    }
    for (const listener of this.listeners) listener(message)
  }

  private async answer(message: RpcMessage): Promise<void> {
    try {
      if (!this.handler) throw new CodexTransportError("protocol", `No handler for ${message.method}`)
      this.write({ id: message.id, result: await this.handler(message) })
    } catch (error) {
      if (!this.closed) this.write({ id: message.id, error: { code: error instanceof CodexRequestRefusal ? error.code : -32603, message: String(error) } })
    }
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      this.clock.clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
  }

  retire(deadline: Deadline): Promise<void> {
    this.retirement ??= this.stop(deadline)
    return this.retirement
  }

  private async stop(deadline: Deadline): Promise<void> {
    this.fail(new CodexTransportError("process", "Codex process retired"))
    const outcome = await this.process.retire(deadline)
    if (!outcome.stopped) throw new CodexTransportError("process", outcome.error.message)
  }
}
