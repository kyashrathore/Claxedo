import { asRecord } from "@claxedo/helpers/guards"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import type { SessionUpdate } from "@agentclientprotocol/sdk"
import type { TranslatorContext } from "./state"
import { diagnoseTranslation, shape, type AcpDiagnostics } from "./diagnostics"

function safePlanEntries(value: unknown, diagnostics: AcpDiagnostics) {
  if (!Array.isArray(value)) {
    diagnoseTranslation(diagnostics, "acp.malformed_plan", {
      reason: "entries_not_array",
      shape: shape(value),
    })
    return []
  }
  return value.flatMap((item, i) => {
    const row = asRecord(item)
    if (!row || typeof row.content !== "string" || typeof row.status !== "string") {
      diagnoseTranslation(diagnostics, "acp.malformed_plan", {
        reason: "entry_missing_content_or_status",
        shape: shape(item),
      })
      return []
    }
    return [
      {
        id: String(i),
        description: row.content,
        status: row.status,
        priority: typeof row.priority === "string" ? row.priority : undefined,
      },
    ]
  })
}

export function planUpdate(
  update: Extract<SessionUpdate, { sessionUpdate: "plan" | "plan_update" | "plan_removed" }>,
  ctx: TranslatorContext,
): AgentRuntimeEvent[] {
  if (update.sessionUpdate === "plan_removed") {
    diagnoseTranslation(ctx.diagnostics, "acp.dropped_content", {
      reason: "unsupported_plan_removed",
      shape: shape(update),
    })
    return []
  }
  const plan = update.sessionUpdate === "plan_update" ? asRecord(update.plan) : undefined
  if (update.sessionUpdate === "plan_update" && plan?.type !== "items") {
    diagnoseTranslation(ctx.diagnostics, "acp.dropped_content", {
      reason: "unsupported_plan_update_content",
      shape: shape(update.plan),
    })
    return []
  }
  const entries = update.sessionUpdate === "plan" ? (update as { entries?: unknown }).entries : plan?.entries
  const todos = safePlanEntries(entries, ctx.diagnostics)
  return todos.length ? [{ type: "todo-update", todos }] : []
}
