import { createKeyedSerializer, errorMessage } from "@claxedo/helpers"
import { asRecordOrEmpty, asString } from "@claxedo/helpers/guards"
import type { Clock, Logger } from "../../contract"
import type { CodexLogin } from "./account"
import { CodexEarlyFrames } from "./early-frames"
import { CodexRequestRefusal, CodexTransportError } from "./errors"
import type { CodexMember } from "./member"
import type { CodexRpc, RpcMessage } from "./rpc"
import { codexCollabAgentCall, codexSubagentActivity } from "./translate"

const RELEASED_THREADS = 1024

function spawnedThreads(message: RpcMessage): string[] {
  if (message.method !== "item/started" && message.method !== "item/completed") return []
  const item = asRecordOrEmpty(message.params).item
  const activity = codexSubagentActivity(item)
  if (activity?.kind === "started") return [activity.agentThreadId]
  const call = codexCollabAgentCall(item)
  return message.method === "item/completed" && call?.toolCallRole === "spawn" ? call.receiverThreadIds : []
}

export class CodexRouter {
  private readonly members = new Set<CodexMember>()
  private readonly threads = new Map<string, CodexMember>()
  private readonly released = new Set<string>()
  private readonly early: CodexEarlyFrames
  private readonly logins = createKeyedSerializer()
  private signedIn?: string

  constructor(readonly raw: CodexRpc, clock: Clock, readonly log: Logger) {
    this.early = new CodexEarlyFrames(clock)
    raw.onRequest((message, signal) => this.answer(message, signal))
    raw.onMessage((message) => this.receive(message))
    raw.onFailure((error) => {
      this.early.clear(error)
      for (const member of this.members) member.fail(error)
    })
  }

  join(member: CodexMember): void { this.members.add(member) }

  leave(member: CodexMember): void {
    this.members.delete(member)
    for (const threadId of this.threadsOf(member)) {
      this.threads.delete(threadId)
      this.released.add(threadId)
      if (this.released.size > RELEASED_THREADS) this.released.delete(this.released.values().next().value!)
    }
  }

  bind(threadId: string, member: CodexMember): void {
    const owner = this.threads.get(threadId)
    if (owner && owner !== member) throw new CodexTransportError("session", `Codex thread ${threadId} belongs to another session on this app-server`)
    this.threads.set(threadId, member)
    this.released.delete(threadId)
    this.early.claim(threadId)
  }

  owns(threadId: string, member: CodexMember): boolean { return this.threads.get(threadId) === member }

  threadsOf(member: CodexMember): string[] { return [...this.threads].flatMap(([threadId, owner]) => owner === member ? [threadId] : []) }

  login(login: CodexLogin | undefined): Promise<void> {
    if (login === undefined) return Promise.resolve()
    const key = JSON.stringify(login)
    return this.logins.run("account", async () => {
      if (this.signedIn === key) return
      await this.raw.request("account/login/start", login)
      this.signedIn = key
    })
  }

  private async refreshPlan(): Promise<unknown> {
    for (const member of this.members) {
      const login = await member.account.refused()
      if (login?.type !== "chatgptAuthTokens") continue
      this.signedIn = JSON.stringify(login)
      return { accessToken: login.accessToken, chatgptAccountId: login.chatgptAccountId, chatgptPlanType: null }
    }
    throw new CodexRequestRefusal(-32000, "No session on this app-server could renew its ChatGPT plan")
  }

  private receive(message: RpcMessage): void {
    if (message.method === "serverRequest/resolved") return
    if (message.method === "account/rateLimits/updated") {
      for (const member of this.members) member.deliver(message)
      return
    }
    const threadId = asString(asRecordOrEmpty(message.params).threadId)
    if (!threadId || this.released.has(threadId)) return
    const owner = this.threads.get(threadId)
    if (!owner) {
      this.early.hold(threadId, message, () => this.receive(message), (reason) => this.dropped(message, threadId, reason))
      return
    }
    const children = spawnedThreads(message).filter((child) => !this.threads.has(child))
    for (const child of children) this.threads.set(child, owner)
    owner.deliver(message)
    for (const child of children) this.early.claim(child)
  }

  private dropped(message: RpcMessage, threadId: string, reason: Error): void {
    this.log.warn("Codex dropped an unrecognized frame for a thread no session owns", { code: "unrecognized-event", method: message.method, threadId, reason: errorMessage(reason) })
  }

  private answer(message: RpcMessage, signal: AbortSignal): Promise<unknown> {
    if (message.method === "account/chatgptAuthTokens/refresh") return this.refreshPlan()
    const threadId = asString(asRecordOrEmpty(message.params).threadId)
    if (!threadId) return Promise.reject(new CodexRequestRefusal(-32601, `Unsupported Codex request ${message.method}`))
    const owner = this.threads.get(threadId)
    if (owner) return owner.answer(message, signal)
    if (this.released.has(threadId)) return Promise.reject(new CodexRequestRefusal(-32000, `Codex thread ${threadId} was released by its session`))
    return this.awaitOwner(threadId, message, signal)
  }

  private async awaitOwner(threadId: string, message: RpcMessage, signal: AbortSignal): Promise<unknown> {
    const answer = Promise.withResolvers<unknown>()
    const cancel = this.early.hold(threadId, message, () => this.answer(message, signal).then(answer.resolve, answer.reject), answer.reject)
    const abort = () => cancel(new CodexRequestRefusal(-32000, "Codex resolved the request before a session owned its thread"))
    signal.addEventListener("abort", abort, { once: true })
    try { return await answer.promise }
    finally { signal.removeEventListener("abort", abort) }
  }
}
