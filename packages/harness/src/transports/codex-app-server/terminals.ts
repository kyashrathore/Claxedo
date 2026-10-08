import { asRecordOrEmpty, asString } from "@claxedo/helpers/guards"
import { errorMessage, settleAtRequestDeadline } from "@claxedo/helpers"
import type { AdapterCancelOutcome, CleanupFact, RecoveryErrorCode } from "@claxedo/agent-runtime-contract"
import type { Deadline } from "../../contract"
import { CodexDeadlineError, CodexNoActiveTurnError, CodexTransportError } from "./errors"
import type { CodexConnection, RpcMessage } from "./rpc"

function cleanupFailure(error: unknown): { code: RecoveryErrorCode; message: string } {
  const code: RecoveryErrorCode = error instanceof CodexDeadlineError ? "deadline_exceeded"
    : error instanceof CodexTransportError && error.className === "protocol" ? "cancellation_unsupported" : "provider_unreachable"
  return { code, message: errorMessage(error) }
}

export function codexStopDeadline(): Deadline {
  return { at: Date.now() + 10_000, signal: new AbortController().signal }
}

export class CodexTerminals {
  private readonly byTurn = new Map<string, Set<string>>()
  private readonly before = new Map<string, Promise<Set<string> | Error>>()
  private readonly completed = new Set<string>()
  private readonly completions = new Map<string, PromiseWithResolvers<void>>()
  private readonly stopping = new Map<string, Promise<AdapterCancelOutcome>>()

  constructor(private readonly rpc: CodexConnection, private readonly threadId: string) {}

  observe(message: RpcMessage): void {
    const params = asRecordOrEmpty(message.params)
    if (asString(params.threadId) !== this.threadId) return
    if (message.method === "turn/completed") {
      const turnId = asString(asRecordOrEmpty(params.turn).id)
      if (turnId) {
        this.completed.add(turnId)
        this.completions.get(turnId)?.resolve()
        this.completions.delete(turnId)
      }
    }
    const item = asRecordOrEmpty(params.item)
    if (item.type !== "commandExecution") return
    const turnId = asString(params.turnId)
    if (!turnId) return
    const ids = this.byTurn.get(turnId) ?? new Set<string>()
    const processId = asString(item.processId)
    if (processId) ids.add(processId)
    else if (!this.before.has(turnId)) {
      this.before.set(turnId, this.inventory(codexStopDeadline()).then((present) => new Set(present),
        (failure: unknown) => failure instanceof Error ? failure : new CodexTransportError("protocol", errorMessage(failure))))
    }
    this.byTurn.set(turnId, ids)
  }

  ranCommand(turnId: string): boolean {
    return this.byTurn.has(turnId)
  }

  async hasBackgroundTasks(deadline: Deadline): Promise<boolean> {
    return (await this.inventory(deadline)).length > 0
  }

  stop(turnId: string, deadline: Deadline): Promise<AdapterCancelOutcome> {
    const previous = this.stopping.get(turnId)
    if (previous) return previous
    const stopping = this.stopOwned(turnId, deadline)
    this.stopping.set(turnId, stopping)
    void stopping.then(undefined, () => this.stopping.delete(turnId))
    return stopping
  }

  private async stopOwned(turnId: string, deadline: Deadline): Promise<AdapterCancelOutcome> {
    let noActive = false
    try {
      await this.rpc.request("turn/interrupt", { threadId: this.threadId, turnId }, this.budget(deadline))
    } catch (error) {
      if (!(error instanceof CodexNoActiveTurnError)) throw error
      noActive = true
    }
    const execution = noActive || await this.completion(turnId, deadline) ? "terminal" as const : "unknown" as const
    const ours = this.byTurn.get(turnId)
    if (!ours) return { execution, cleanup: execution === "terminal" ? "verified_clear" : "unknown" }
    try { return { execution, cleanup: await this.release(turnId, ours, deadline) } }
    catch (error) { return { execution, cleanup: "unknown", error: cleanupFailure(error) } }
  }

  private async completion(turnId: string, deadline: Deadline): Promise<boolean> {
    if (this.completed.has(turnId)) return true
    const completion = this.completions.get(turnId) ?? Promise.withResolvers<void>()
    this.completions.set(turnId, completion)
    try {
      await settleAtRequestDeadline("Codex turn completion", { signal: deadline.signal, deadlineAt: deadline.at }, completion.promise,
        () => {}, () => new CodexDeadlineError("Codex turn completion was not observed before the stop deadline"))
      return true
    } catch (error) {
      if (error instanceof CodexDeadlineError) return false
      throw error
    }
  }

  async clear(deadline: Deadline): Promise<void> {
    await this.terminate(await this.inventory(deadline), deadline)
  }

  private async terminate(processIds: string[], deadline: Deadline): Promise<void> {
    for (const processId of processIds) {
      await this.rpc.request("thread/backgroundTerminals/terminate", { threadId: this.threadId, processId }, this.budget(deadline))
    }
  }

  private async release(turnId: string, ours: Set<string>, deadline: Deadline): Promise<CleanupFact> {
    await this.terminate(await this.survivors(turnId, ours, deadline), deadline)
    const remaining = await this.survivors(turnId, ours, deadline)
    if (remaining.length) return "owned"
    this.byTurn.delete(turnId)
    this.before.delete(turnId)
    return "verified_clear"
  }

  private async survivors(turnId: string, ours: Set<string>, deadline: Deadline): Promise<string[]> {
    const listed = await this.inventory(deadline)
    const pending = this.before.get(turnId)
    if (!pending) return listed.filter((id) => ours.has(id))
    const before = await pending
    if (before instanceof Error) throw before
    const named = new Set([...this.byTurn].filter(([id]) => id !== turnId).flatMap(([, ids]) => [...ids]))
    return listed.filter((id) => ours.has(id) || (!before.has(id) && !named.has(id)))
  }

  private async inventory(deadline: Deadline): Promise<string[]> {
    const found = new Set<string>()
    let cursor: string | undefined
    do {
      const result = asRecordOrEmpty(await this.rpc.request("thread/backgroundTerminals/list",
        { threadId: this.threadId, ...(cursor ? { cursor } : {}) }, this.budget(deadline)))
      if (!Array.isArray(result.data)) throw new CodexTransportError("protocol", "Codex returned an invalid background terminal list")
      for (const value of result.data) {
        const id = asString(asRecordOrEmpty(value).processId)
        if (id) found.add(id)
      }
      cursor = asString(result.nextCursor)
    } while (cursor)
    return [...found]
  }

  private budget(deadline: Deadline): number {
    if (deadline.signal.aborted || deadline.at <= Date.now()) throw new CodexDeadlineError("Codex stop deadline expired")
    return Math.max(1, Math.min(30_000, deadline.at - Date.now()))
  }
}
