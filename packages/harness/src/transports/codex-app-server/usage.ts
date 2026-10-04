import { asRecordOrEmpty, asString } from "@claxedo/helpers/guards"
import { codexReportedModel, codexUsageGrowth } from "./translate"
import type { OutsideTurnUsage } from "../../contract"
import type { RpcMessage } from "./rpc"

export type UsageFact = Omit<OutsideTurnUsage, "usage">
export type ThreadOwnership = "owned" | "side" | "detached" | "unknown"

export class CodexUsageLedger {
  private readonly totals = new Map<string, Record<string, unknown>>()
  private readonly models = new Map<string, string>()
  private lastTurn?: UsageFact

  attach(fact: UsageFact): void {
    this.lastTurn = fact
  }

  observe(message: RpcMessage, ownership: ThreadOwnership): { usage?: OutsideTurnUsage; unbilled?: string } {
    const params = asRecordOrEmpty(message.params)
    const reported = message.method ? codexReportedModel(message.method, params) : undefined
    if (reported) this.models.set(reported.turnId ? `${reported.threadId}\0${reported.turnId}` : reported.threadId, reported.model)
    if (message.method !== "thread/tokenUsage/updated") return {}
    const threadId = asString(params.threadId)
    if (!threadId) return {}
    const turnId = asString(params.turnId)
    const growth = codexUsageGrowth({ payload: params, previousTotal: this.totals.get(threadId),
      scope: ownership === "owned" ? threadId : `${ownership === "side" ? "title" : "detached"}:${threadId}`,
      model: (turnId ? this.models.get(`${threadId}\0${turnId}`) : undefined) ?? this.models.get(threadId) })
    if (growth.total) this.totals.set(threadId, growth.total)
    if (ownership === "owned" || !growth.event) return {}
    if (ownership === "unknown" || !this.lastTurn) return { unbilled: threadId }
    return { usage: { ...this.lastTurn, usage: growth.event } }
  }
}
