import { asRecord } from "@claxedo/helpers/guards"
import { type AgentRuntimeEvent, asText as text } from "@claxedo/agent-runtime-contract"
import type { SessionUpdate } from "./types"
import type { TranslatorContext } from "./state"
import { diagnoseTranslation, shape, type AcpDiagnostics } from "./diagnostics"

type ConfigUpdateEvent = Extract<AgentRuntimeEvent, { type: "config-update" }>
type ConfigUpdateOption = ConfigUpdateEvent["options"][number]

function decodeSelectOptions(value: unknown): Array<{ id: string; name: string }> {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const row = asRecord(entry)
    if (!row) return []
    if (Array.isArray(row.options)) return decodeSelectOptions(row.options)
    if (typeof row.value === "string" && typeof row.name === "string") return [{ id: row.value, name: row.name }]
    return []
  })
}

function decodeConfigOptions(value: unknown, diagnostics: AcpDiagnostics): ConfigUpdateOption[] {
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

export function configOptionUpdate(
  update: Extract<SessionUpdate, { sessionUpdate: "config_option_update" }>,
  ctx: TranslatorContext,
): AgentRuntimeEvent[] {
  const options = decodeConfigOptions(update.configOptions, ctx.diagnostics)
  return options.length ? [{ type: "config-update", options }] : []
}
