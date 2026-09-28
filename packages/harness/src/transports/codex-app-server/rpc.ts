import type { OwnedProcess, HarnessServices, Deadline } from "../../contract"
import { asRecordOrEmpty, asString, assertRecord } from "@claxedo/helpers/guards"
import { errorMessage } from "@claxedo/helpers"
import { NdjsonOwnedProcess } from "../../rpc/channel"
import { PendingRpcRequests } from "../../rpc/pending"
import { CodexRequestRefusal, CodexTransportError, codexRpcError } from "./errors"

export type RpcMessage = { id?: string | number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } }

export function codexRetirementDeadline(services: HarnessServices): Deadline {
  return { at: services.clock.now() + 10_000, signal: new AbortController().signal }
}

export class CodexRpc {
  private serial = 0
  private readonly channel: NdjsonOwnedProcess
  private readonly pending: PendingRpcRequests<number>
  private readonly listeners = new Set<(message: RpcMessage) => void>()
  private handler?: (message: RpcMessage) => Promise<unknown>

  constructor(readonly process: OwnedProcess, clock: HarnessServices["clock"]) {
    this.pending = new PendingRpcRequests(clock)
    this.channel = new NdjsonOwnedProcess(process, clock, (value) => this.receive(this.decode(value)), (reason, cause) =>
      new CodexTransportError(reason === "frame" ? "protocol" : "process",
        reason === "frame" ? "Invalid Codex JSON-RPC frame" : `Codex ${reason} failed`, { cause }),
    (error) => console.error("Codex process retirement failed", error))
    this.channel.onFailure((error) => this.pending.fail(error))
  }

  onMessage(listener: (message: RpcMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onFailure(listener: (error: Error) => void): () => void { return this.channel.onFailure(listener) }

  onRequest(handler: (message: RpcMessage) => Promise<unknown>): void { this.handler = handler }

  request(method: string, params?: unknown, ms = 30_000): Promise<unknown> {
    if (!this.channel.alive) return Promise.reject(new CodexTransportError("process", `Codex ${method} was not sent after process exit`))
    const id = ++this.serial
    return this.pending.request(id, undefined, ms, () =>
      new CodexTransportError("protocol", `Codex ${method} did not answer within ${ms}ms`),
    () => this.channel.send({ id, method, params }))
  }

  notify(method: string, params?: unknown): void {
    this.channel.send({ method, ...(params === undefined ? {} : { params }) })
  }

  private decode(value: unknown): RpcMessage {
    const fields = assertRecord(value, "Codex JSON-RPC frame")
    const error = asRecordOrEmpty(fields.error)
    return {
      ...(typeof fields.id === "number" || typeof fields.id === "string" ? { id: fields.id } : {}),
      ...(asString(fields.method) ? { method: asString(fields.method) } : {}),
      params: fields.params, result: fields.result,
      ...(typeof error.code === "number" && typeof error.message === "string"
        ? { error: { code: error.code, message: error.message } } : {}),
    }
  }

  private receive(message: RpcMessage): void {
    if (typeof message.id === "number" && !message.method) {
      if (message.error) this.pending.reject(message.id, codexRpcError(message.error))
      else this.pending.resolve(message.id, message.result)
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
      this.channel.send({ id: message.id, result: await this.handler(message) })
    } catch (error) {
      if (this.channel.alive) this.channel.send({ id: message.id,
        error: { code: error instanceof CodexRequestRefusal ? error.rpcCode : -32603, message: errorMessage(error) } })
    }
  }

  retire(deadline: Deadline): Promise<void> {
    this.channel.fail(new CodexTransportError("process", "Codex process retired"), false)
    return this.process.retire(deadline).then((outcome) => {
      if (!outcome.stopped) throw new CodexTransportError("process", outcome.error.message)
    })
  }
}
