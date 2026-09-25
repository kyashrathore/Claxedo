import { asRecordOrEmpty, asString } from "@claxedo/helpers/guards"
import { settleAtRequestDeadline } from "@claxedo/helpers"
import type { AdapterCancelOutcome } from "@claxedo/agent-runtime-contract"
import type { Deadline } from "../../contract"
import { CodexNoActiveTurnError, CodexTransportError } from "./errors"
import type { CodexRpc, RpcMessage } from "./rpc"

export class CodexTerminals {
  private readonly byTurn = new Map<string, Set<string>>()
  private readonly completed = new Set<string>()
  private readonly completionWaiters = new Map<string, Set<() => void>>()
  private readonly stopping = new Map<string, Promise<AdapterCancelOutcome>>()

  constructor(private readonly rpc: CodexRpc, private readonly threadId: string) {}

  observe(message: RpcMessage): void {
    const params = asRecordOrEmpty(message.params)
    if (asString(params.threadId) !== this.threadId) return
    if (message.method === "turn/completed") {
      const turnId = asString(asRecordOrEmpty(params.turn).id)
      if (turnId) {
        this.completed.add(turnId)
        for (const waiter of this.completionWaiters.get(turnId) ?? []) waiter()
        this.completionWaiters.delete(turnId)
      }
    }
    const item = asRecordOrEmpty(params.item)
    if (item.type !== "commandExecution") return
    const turnId = asString(params.turnId)
    const processId = asString(item.processId)
    if (!turnId || !processId) return
    const ids = this.byTurn.get(turnId) ?? new Set<string>()
    ids.add(processId)
    this.byTurn.set(turnId, ids)
  }

  stop(turnId: string, deadline: Deadline): Promise<AdapterCancelOutcome> {
    const previous = this.stopping.get(turnId)
    if (previous) return previous
    const stopping = this.stopOwned(turnId, deadline)
    this.stopping.set(turnId, stopping)
    void stopping.then(undefined, () => this.stopping.delete(turnId))
    return stopping
  }

  async confirm(turnId: string, outcome: AdapterCancelOutcome, deadline: Deadline): Promise<AdapterCancelOutcome> {
    if (!this.completed.has(turnId)) await this.waitForCompletion(turnId, deadline)
    if (outcome.cleanup === "verified_clear") return { execution: "terminal", cleanup: "verified_clear" }
    const ours = this.byTurn.get(turnId)
    if (!ours?.size) return { execution: "terminal", cleanup: "verified_clear" }
    const remaining = await this.survivors(ours, deadline)
    return { execution: "terminal", cleanup: remaining.length ? "owned" : "verified_clear" }
  }

  private async waitForCompletion(turnId: string, deadline: Deadline): Promise<void> {
    const waiters = this.completionWaiters.get(turnId) ?? new Set<() => void>()
    let complete!: () => void
    const pending = new Promise<void>((resolve) => { complete = resolve })
    waiters.add(complete)
    this.completionWaiters.set(turnId, waiters)
    if (this.completed.has(turnId)) complete()
    try {
      await settleAtRequestDeadline("Codex turn completion", { signal: deadline.signal, deadlineAt: deadline.at }, pending,
        () => waiters.delete(complete), () => new CodexTransportError("process", "Codex turn completion was not observed before the stop deadline"))
    } finally {
      waiters.delete(complete)
      if (!waiters.size) this.completionWaiters.delete(turnId)
    }
  }

  private async stopOwned(turnId: string, deadline: Deadline): Promise<AdapterCancelOutcome> {
    let noActive = false
    try {
      await this.rpc.request("turn/interrupt", { threadId: this.threadId, turnId }, this.budget(deadline))
    } catch (error) {
      if (!(error instanceof CodexNoActiveTurnError)) throw error
      noActive = true
    }
    const execution = noActive || this.completed.has(turnId) ? "terminal" as const : "unknown" as const
    const ours = this.byTurn.get(turnId)
    if (!ours?.size) return { execution, cleanup: "unknown" }
    let remaining = await this.survivors(ours, deadline)
    for (const processId of remaining) {
      await this.rpc.request("thread/backgroundTerminals/terminate", { threadId: this.threadId, processId }, this.budget(deadline))
    }
    remaining = await this.survivors(ours, deadline)
    if (remaining.length) return { execution, cleanup: "owned" }
    this.byTurn.delete(turnId)
    return { execution, cleanup: "verified_clear" }
  }

  private async survivors(ours: Set<string>, deadline: Deadline): Promise<string[]> {
    return (await this.inventory(deadline)).filter((id) => ours.has(id))
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
    if (deadline.signal.aborted || deadline.at <= Date.now()) throw new CodexTransportError("process", "Codex stop deadline expired")
    return Math.max(1, Math.min(30_000, deadline.at - Date.now()))
  }
}
