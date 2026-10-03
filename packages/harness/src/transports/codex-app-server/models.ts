import type { AgentConfigOption } from "@claxedo/agent-runtime-contract"
import { asRecordOrEmpty, asString } from "@claxedo/helpers/guards"
import type { v2 } from "./translate"
import { CodexTransportError } from "./errors"
import { modelAndEffortOptions } from "../../contract"
import type { CodexConnection } from "./rpc"

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

export async function readCodexModels(rpc: CodexConnection): Promise<CodexModel[]> {
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
  const options = modelAndEffortOptions({ selected: selected.id,
    models: models.filter((model) => !model.hidden || model.id === selected.id)
      .map((model) => ({ id: model.id, name: model.name, ...(model.description ? { description: model.description } : {}) })),
    efforts: selected.efforts,
    currentEffort: selected.defaultEffort && selected.efforts.includes(selected.defaultEffort) ? selected.defaultEffort : undefined })
  if (selected.tiers.length) options.push({ id: "service_tier", name: "Speed", category: "service_tier", type: "select",
    selectOptions: selected.tiers })
  return options
}

export type CodexTurnSettings = Pick<v2.TurnStartParams, "model" | "effort" | "serviceTier" | "summary">

export function codexTurnSettings(models: readonly CodexModel[], requested: {
  model?: string; effort?: string | null; serviceTier?: string | null
}): CodexTurnSettings {
  const row = selectedModel(models, requested.model)
  const model = row?.id ?? (requested.model === "default" ? undefined : requested.model)
  if (requested.effort && (!row || !row.efforts.includes(requested.effort))) {
    throw new CodexTransportError("configuration", `Codex does not run ${model ?? "its default model"} at effort ${requested.effort}; it accepts ${row?.efforts.join(", ") || "none"}`)
  }
  const effort = requested.effort ?? (row?.defaultEffort && row.efforts.includes(row.defaultEffort) ? row.defaultEffort : undefined)
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}),
    serviceTier: requested.serviceTier && row?.tiers.some((tier) => tier.id === requested.serviceTier) ? requested.serviceTier : null, summary: "auto" }
}
