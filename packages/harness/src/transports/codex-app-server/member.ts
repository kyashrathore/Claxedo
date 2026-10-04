import { errorMessage } from "@claxedo/helpers"
import type { CodexAccountLogin } from "./account"
import { asRecordOrEmpty, asString } from "@claxedo/helpers/guards"
import { CodexRequestRefusal, CodexTransportError } from "./errors"
import type { CodexRouter } from "./router"
import type { CodexConnection, CodexRequestHandler, RpcMessage } from "./rpc"

const LOGIN_BEFORE: readonly string[] = ["thread/start", "thread/resume", "turn/start", "thread/goal/set"]
const OPENING: readonly string[] = ["thread/resume", "thread/unarchive"]

function resultThread(result: unknown): string | undefined {
  return asString(asRecordOrEmpty(asRecordOrEmpty(result).thread).id)
}

export class CodexMember implements CodexConnection {
  private state: "joined" | "failed" | "left" = "joined"
  private readonly listeners = new Set<(message: RpcMessage) => void>()
  private readonly failures = new Set<(error: Error) => void>()
  private handler?: CodexRequestHandler

  constructor(private readonly router: CodexRouter, readonly account: CodexAccountLogin) {
    router.join(this)
  }

  get alive(): boolean { return this.state === "joined" && this.router.raw.alive }

  get threads(): string[] { return this.router.threadsOf(this) }

  async request(method: string, params?: unknown, ms?: number): Promise<unknown> {
    if (!this.alive) throw new CodexTransportError("process", `Codex ${method} was not sent: the session no longer holds its app-server`)
    const threadId = asString(asRecordOrEmpty(params).threadId)
    if (threadId && !OPENING.includes(method) && !this.router.owns(threadId, this)) {
      throw new CodexTransportError("session", `Codex thread ${threadId} does not belong to this session`)
    }
    if (LOGIN_BEFORE.includes(method)) await this.router.login(await this.account.current())
    const result = await this.router.raw.request(method, params, ms)
    const opened = method === "thread/start" || method === "thread/resume" ? resultThread(result) : undefined
    if (opened) this.router.bind(opened, this)
    return result
  }

  onMessage(listener: (message: RpcMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onFailure(listener: (error: Error) => void): () => void {
    this.failures.add(listener)
    return () => this.failures.delete(listener)
  }

  onRequest(handler: CodexRequestHandler): void { this.handler = handler }

  deliver(message: RpcMessage): void {
    if (this.state !== "joined") return
    for (const listener of this.listeners) listener(message)
  }

  answer(message: RpcMessage, signal: AbortSignal): Promise<unknown> {
    if (this.state !== "joined" || !this.handler) return Promise.reject(new CodexRequestRefusal(-32000, "Codex session is not attached"))
    return this.handler(message, signal)
  }

  fail(error: Error): void {
    if (this.state !== "joined") return
    this.state = "failed"
    for (const listener of this.failures) listener(error)
  }

  abandonTurn(threadId: string, answer: Promise<unknown>, error: Error): void {
    this.fail(error)
    void answer.then((result) => {
      const turnId = asString(asRecordOrEmpty(asRecordOrEmpty(result).turn).id)
      return turnId ? this.router.raw.request("turn/interrupt", { threadId, turnId }) : undefined
    }).then(undefined, (cause: unknown) => this.router.log.warn("Codex could not interrupt a turn whose start timed out", { threadId, error: errorMessage(cause) }))
  }

  async archive(threadId: string): Promise<void> {
    if (this.state === "left" || !this.router.raw.alive) return
    await this.router.raw.request("thread/archive", { threadId })
  }

  leave(): void {
    if (this.state === "left") return
    this.state = "left"
    this.router.leave(this)
  }
}
