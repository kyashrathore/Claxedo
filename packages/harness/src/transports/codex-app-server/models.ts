import type { AgentConfigOption } from "@claxedo/agent-runtime-contract"
import { asRecordOrEmpty, asString } from "@claxedo/helpers/guards"
import type { v2 } from "@claxedo/agent-event-runtime/harnesses/codex"
import { CodexTransportError } from "./errors"
import type { CodexRpc } from "./rpc"

export type CodexModel = {
  id: string
  name: string
  description?: string
  hidden: boolean
  isDefault: boolean
  efforts: string[]
  defaultEffort?: string
  tiers: { id: string; name: string; description?: string }[]
}

function reasoningEffort(value: string | undefined): v2.TurnStartParams["effort"] {
  if (value === undefined) return undefined
  if (value === "none" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh") return value
  throw new CodexTransportError("configuration", `Unsupported Codex effort ${value}`)
}

export async function readCodexModels(rpc: CodexRpc): Promise<CodexModel[]> {
  const models = new Map<string, CodexModel>()
  let cursor: string | undefined
  do {
    const result = asRecordOrEmpty(await rpc.request("model/list", cursor ? { cursor } : {}))
    for (const item of Array.isArray(result.data) ? result.data : []) {
      const row = asRecordOrEmpty(item)
      const id = asString(row.model) ?? asString(row.id)
      if (!id || models.has(id)) continue
      const efforts = (Array.isArray(row.supportedReasoningEfforts) ? row.supportedReasoningEfforts : [])
        .flatMap((value) => asString(asRecordOrEmpty(value).reasoningEffort) ?? [])
      const tiers = (Array.isArray(row.serviceTiers) ? row.serviceTiers : []).flatMap((value) => {
        const tier = asRecordOrEmpty(value)
        const tierId = asString(tier.id)
        if (!tierId) return []
        const description = asString(tier.description)
        return [{ id: tierId, name: asString(tier.name) ?? tierId, ...(description ? { description } : {}) }]
      })
      const description = asString(row.description)
      models.set(id, { id, name: asString(row.displayName) ?? id,
        ...(description ? { description } : {}), hidden: row.hidden === true, isDefault: row.isDefault === true,
        efforts, ...(asString(row.defaultReasoningEffort) ? { defaultEffort: asString(row.defaultReasoningEffort)! } : {}), tiers })
    }
    cursor = asString(result.nextCursor)
  } while (cursor)
  return [...models.values()]
}

function selectedModel(models: readonly CodexModel[], id: string | undefined): CodexModel | undefined {
  return id && id !== "default" ? models.find((model) => model.id === id) : models.find((model) => model.isDefault) ?? models[0]
}

export function codexModelOptions(models: readonly CodexModel[], requested: string | undefined): AgentConfigOption[] {
  const selected = selectedModel(models, requested) ?? selectedModel(models, undefined)
  if (!selected) return []
  const options: AgentConfigOption[] = [{ id: "model", name: "Model", category: "model", type: "select",
    currentValue: selected.id, selectOptions: models.filter((model) => !model.hidden || model.id === selected.id)
      .map((model) => ({ id: model.id, name: model.name, ...(model.description ? { description: model.description } : {}) })) }]
  if (selected.efforts.length > 1) options.push({ id: "effort", name: "Effort", category: "thought_level", type: "select",
    ...(selected.defaultEffort && selected.efforts.includes(selected.defaultEffort) ? { currentValue: selected.defaultEffort } : {}),
    selectOptions: selected.efforts.map((id) => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1) })) })
  if (selected.tiers.length) options.push({ id: "service_tier", name: "Speed", category: "service_tier", type: "select",
    selectOptions: selected.tiers })
  return options
}

export function codexTurnSettings(models: readonly CodexModel[], requested: {
  model?: string; effort?: string | null; serviceTier?: string | null
}): Pick<v2.TurnStartParams, "model" | "effort" | "serviceTier"> {
  const row = selectedModel(models, requested.model)
  const model = row?.id ?? (requested.model === "default" ? undefined : requested.model)
  if (requested.effort && (!row || !row.efforts.includes(requested.effort))) {
    throw new CodexTransportError("configuration", `Codex does not run ${model ?? "its default model"} at effort ${requested.effort}; it accepts ${row?.efforts.join(", ") || "none"}`)
  }
  const effort = requested.effort ?? (row?.defaultEffort && row.efforts.includes(row.defaultEffort) ? row.defaultEffort : undefined)
  return { ...(model ? { model } : {}), ...(effort ? { effort: reasoningEffort(effort) } : {}),
    serviceTier: requested.serviceTier && row?.tiers.some((tier) => tier.id === requested.serviceTier) ? requested.serviceTier : null }
}
