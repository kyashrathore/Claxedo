import { randomUUID } from "node:crypto"
import type { Clock, Deadline, OwnedProcess } from "../../contract"
import { unrecognizedEvent } from "../../translate/unrecognized"
import { PiTransportError } from "./errors"

export type PiMessage = Record<string, unknown> & { type: string }
type Pending = { command: string; resolve(value: unknown): void; reject(error: Error): void; timer: unknown }

export class PiRpc {
  private buffer = ""
  private readonly pending = new Map<string, Pending>()
  private readonly listeners = new Set<(message: PiMessage) => void>()
  private readonly failures = new Set<(error: Error) => void>()
  private failed?: Error
  private exitReported = false
  private retirement?: Promise<void>

  constructor(readonly process: OwnedProcess, private readonly clock: Clock,
    private readonly diagnostic: (event: ReturnType<typeof unrecognizedEvent>) => void) {
    process.stdout.setEncoding("utf8")
    process.stdout.on("data", (chunk: string) => this.read(chunk))
    process.stdout.on("error", (error: Error) => this.fail(new PiTransportError("process", "Pi stdout failed", error)))
    process.stderr.resume()
    void process.exited.then((exit) => {
      this.exitReported = true
      this.fail(new PiTransportError("process", `Pi process exited (${exit.signal ?? exit.code})`))
    }, (error: unknown) => this.fail(new PiTransportError("process", "Pi exit observation failed", error)))
  }

  get alive(): boolean { return !this.failed && !this.exitReported }
  get exited(): boolean { return this.exitReported }

  onEvent(listener: (message: PiMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onFailure(listener: (error: Error) => void): () => void {
    if (this.failed) listener(this.failed)
    else this.failures.add(listener)
    return () => this.failures.delete(listener)
  }

  private read(chunk: string): void {
    this.buffer += chunk
    let index = this.buffer.indexOf("\n")
    while (index >= 0) {
      if (index > 16 * 1024 * 1024) return this.fail(new PiTransportError("protocol", "Pi RPC record exceeds 16 MiB"))
      const line = this.buffer.slice(0, index).replace(/\r$/, "")
      this.buffer = this.buffer.slice(index + 1)
      if (line) {
        try { this.receive(JSON.parse(line) as unknown) }
        catch (error) { this.fail(new PiTransportError("protocol", "Invalid Pi RPC record", error)); return }
      }
      index = this.buffer.indexOf("\n")
    }
    if (this.buffer.length > 16 * 1024 * 1024) this.fail(new PiTransportError("protocol", "Pi RPC record exceeds 16 MiB"))
  }

  private receive(value: unknown): void {
    if (!value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string") throw new Error("Pi RPC message has no type")
    const message: PiMessage = { ...value, type: value.type }
    if (message.type === "response") {
      if (typeof message.id !== "string") throw new Error("Pi RPC response has no id")
      const pending = this.pending.get(message.id)
      if (!pending || message.command !== pending.command) {
        this.diagnostic(unrecognizedEvent("pi.rpc", `response.${String(message.command)}`, message))
        return
      }
      this.pending.delete(message.id)
      this.clock.clearTimeout(pending.timer)
      if (message.success === true) pending.resolve(message.data)
      else pending.reject(new PiTransportError("protocol", typeof message.error === "string" ? message.error : "Pi rejected the command"))
      return
    }
    for (const listener of this.listeners) listener(message)
  }

  send(message: PiMessage): void {
    if (this.failed) throw this.failed
    this.process.stdin.write(`${JSON.stringify(message)}\n`, (error?: Error | null) => {
      if (error) this.fail(new PiTransportError("process", "Pi stdin write failed", error))
    })
  }

  request(type: string, body: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<unknown> {
    if (this.failed) return Promise.reject(this.failed)
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = this.clock.setTimeout(() => {
        this.pending.delete(id)
        reject(new PiTransportError("timeout", `Pi ${type} timed out`))
      }, timeoutMs)
      this.pending.set(id, { command: type, resolve, reject, timer })
      try { this.send({ type, id, ...body }) }
      catch (error) { this.pending.delete(id); this.clock.clearTimeout(timer); reject(error) }
    })
  }

  private fail(error: Error): void {
    if (this.failed) return
    this.failed = error
    for (const pending of this.pending.values()) {
      this.clock.clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    for (const listener of this.failures) listener(error)
  }

  retire(deadline: Deadline): Promise<void> {
    if (!this.retirement) {
      const attempt = this.retireOnce(deadline)
      this.retirement = attempt
      void attempt.then(undefined, () => {
        if (this.retirement === attempt) this.retirement = undefined
      })
    }
    return this.retirement
  }

  private async retireOnce(deadline: Deadline): Promise<void> {
    this.fail(new PiTransportError("process", "Pi process retired"))
    const outcome = await this.process.retire(deadline)
    if (!outcome.stopped) throw new PiTransportError("retirement", outcome.error.message)
  }
}
