import type { SessionUpdate } from "./types"
import type { TranslatorContext } from "./state"
import { asRecord } from "@claxedo/helpers/guards"
import { type AgentRuntimeEvent, asRecord as object, asText as text } from "@claxedo/agent-runtime-contract"
import { diagnoseTranslation, shape, type AcpDiagnostics } from "./diagnostics"

type ConfigUpdateEvent = Extract<AgentRuntimeEvent, { type: "config-update" }>
type ConfigUpdateOption = ConfigUpdateEvent["options"][number]

function decodeSelectOptions(value: unknown): Array<{ id: string; name: string }> {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const row = object(entry)
    if (!row) return []
    if (Array.isArray(row.options)) return decodeSelectOptions(row.options)
    if (typeof row.value === "string" && typeof row.name === "string") return [{ id: row.value, name: row.name }]
    return []
  })
}

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

export function decodeConfigOptions(value: unknown, diagnostics: AcpDiagnostics): ConfigUpdateOption[] {
  if (!Array.isArray(value)) {
    diagnoseTranslation(diagnostics, "acp.malformed_config_options", {
      reason: "configOptions_not_array",
      shape: shape(value),
    })
    return []
  }
  return value.flatMap((item): ConfigUpdateOption[] => {
    const row = asRecord(item)
    if (!row || typeof row.id !== "string" || typeof row.name !== "string") {
      diagnoseTranslation(diagnostics, "acp.malformed_config_options", {
        reason: "option_missing_id_or_name",
        shape: shape(item),
      })
      return []
    }
    const common = { id: row.id, name: row.name, category: text(row.category) }
    if (row.type === "select" && typeof row.currentValue === "string") {
      return [
        {
          ...common,
          type: "select" as const,
          currentValue: row.currentValue,
          selectOptions: decodeSelectOptions(row.options),
        },
      ]
    }
    if (row.type === "boolean" && typeof row.currentValue === "boolean") {
      return [{ ...common, type: "boolean" as const, currentValue: row.currentValue }]
    }
    diagnoseTranslation(diagnostics, "acp.malformed_config_options", {
      reason: "option_invalid_type_or_value",
      shape: shape(item),
    })
    return []
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
