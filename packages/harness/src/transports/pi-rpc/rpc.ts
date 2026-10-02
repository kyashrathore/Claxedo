import { randomUUID } from "node:crypto"
import { settleAtRequestDeadline } from "@claxedo/helpers"
import type { Clock, Deadline, OwnedProcess } from "../../contract"
import { NdjsonOwnedProcess } from "../../rpc/channel"
import { PendingRpcRequests } from "../../rpc/pending"
import { StderrTail } from "../../rpc/stderr-tail"
import { unrecognizedEvent } from "../../translate/unrecognized"
import { TransportError } from "../../contract/errors"

export type PiMessage = Record<string, unknown> & { type: string }

export class PiRpc {
  private readonly channel: NdjsonOwnedProcess
  private readonly pending: PendingRpcRequests<string, string>
  private readonly listeners = new Set<(message: PiMessage) => void>()
  private exitReported = false
  private retired = false
  private readonly stderr: StderrTail

  constructor(readonly process: OwnedProcess, clock: Clock,
    private readonly diagnostic: (event: ReturnType<typeof unrecognizedEvent>) => void) {
    this.pending = new PendingRpcRequests(clock)
    this.stderr = new StderrTail(process)
    this.channel = new NdjsonOwnedProcess(process, clock, (value) => this.receive(value), (reason, cause) => {
      if (reason === "exit") {
        this.exitReported = true
        if (cause && typeof cause === "object" && "code" in cause) {
          const code = cause.code
          const signal = "signal" in cause ? cause.signal : undefined
          const reason = this.stderr.value
          return new TransportError("pi", "process", `Pi process exited (${String(signal ?? code)})${reason ? `: ${reason}` : ""}`)
        }
        return new TransportError("pi", "process", "Pi exit observation failed", { cause })
      }
      return new TransportError("pi", reason === "frame" ? "protocol" : "process",
        reason === "frame" ? "Invalid Pi RPC record" : `Pi ${reason} failed`, { cause })
    }, (error) => this.diagnostic(unrecognizedEvent("pi.rpc", "retirement", error)))
    this.channel.onFailure((error) => this.pending.fail(error))
  }

  get alive(): boolean { return this.channel.alive && !this.exitReported }
  get exited(): boolean { return this.exitReported }

  onEvent(listener: (message: PiMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onFailure(listener: (error: Error) => void): () => void { return this.channel.onFailure(listener) }

  onLoss(listener: (error: Error) => void): () => void {
    return this.channel.onFailure((error) => { if (!this.retired) listener(error) })
  }

  private receive(value: unknown): void {
    if (!value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string") throw new Error("Pi RPC message has no type")
    const message: PiMessage = { ...value, type: value.type }
    if (message.type === "response") {
      if (typeof message.id !== "string") throw new Error("Pi RPC response has no id")
      const command = this.pending.get(message.id)
      if (!command || message.command !== command) {
        this.diagnostic(unrecognizedEvent("pi.rpc", `response.${String(message.command)}`, message))
        return
      }
      if (message.success === true) this.pending.resolve(message.id, message.data)
      else this.pending.reject(message.id, new TransportError("pi",
        command === "set_model" || command === "set_thinking_level" ? "configuration" : "protocol",
        typeof message.error === "string" ? message.error : "Pi rejected the command"))
      return
    }
    for (const listener of this.listeners) listener(message)
  }

  send(message: PiMessage): void { this.channel.send(message) }

  request(type: string, body: Record<string, unknown> = {}, limit: number | Deadline = 30_000): Promise<unknown> {
    const id = randomUUID()
    const timeout = () => new TransportError("pi", "timeout", `Pi ${type} timed out`)
    if (typeof limit !== "number" && (limit.signal.aborted || limit.at <= Date.now())) return Promise.reject(timeout())
    const request = this.pending.request(id, type, typeof limit === "number" ? limit : undefined, timeout,
      () => this.send({ type, id, ...body }))
    if (typeof limit === "number") return request
    return settleAtRequestDeadline(`Pi ${type}`, { deadlineAt: limit.at, signal: limit.signal }, request,
      () => { this.pending.reject(id, timeout()) }, timeout)
  }

  async stop(deadline: Deadline): Promise<void> {
    const results = await Promise.allSettled([this.request("clear_queue", {}, deadline), this.request("abort", {}, deadline)])
    const failure = results.find((result) => result.status === "rejected")
    if (failure?.status === "rejected") throw failure.reason
  }

  retire(deadline: Deadline): Promise<void> {
    this.retired = true
    this.channel.fail(new TransportError("pi", "process", "Pi process retired"), false)
    return this.process.retire(deadline).then((outcome) => {
      if (!outcome.stopped) throw new TransportError("pi", "retirement", outcome.error.message)
    })
  }
}
