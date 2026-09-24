import { randomUUID } from "crypto"
import type { AgentConfigOption } from "../../index"
import type { AgentProcessObserver } from "@claxedo/process-ownership/process-observer"
import { observeAgentProcess } from "@claxedo/process-ownership/process-observer"
import {
  catalogModel,
  modelConfigOption,
  requireTurnEffort,
  resolveSupportedServiceTier,
  serviceTierConfigOption,
  thoughtLevelConfigOption,
  type SdkModelEntry,
  type SdkServiceTier,
} from "../../sdk-model-options"
import { asRecord } from "@claxedo/helpers/guards"
import { controlRequestDeadline } from "../shared/request-deadline"
import { text } from "../shared/sdk-runtime-adapter"
import type { CodexAppServerProcess } from "./app-server-process"
import { codexAppServerModel } from "./protocol"

/**
 * The model, effort and service tier a thread runs next. Codex keeps a
 * thread's last `model`, `effort` and `serviceTier` for whatever a request
 * omits, so all three are always named: "default" becomes the catalog's
 * default row, an unrequested effort that model's own default, and the
 * standard tier an explicit `null`, since a `service_tier` in the user's Codex
 * config applies when none is named. `catalog` must be loaded, not peeked: a
 * cold one (a restarted server, a caller that never opened the picker) would
 * leave the model and effort unnamed.
 */
export function codexThreadSettings(
  catalog: readonly SdkModelEntry[],
  requested: { model?: string; effort?: string; serviceTier?: string },
) {
  const row = catalogModel(catalog, requested.model)
  const model = row?.id ?? requested.model
  const effort = requireTurnEffort({ harness: "Codex", models: catalog, modelId: model, requested: requested.effort })
    ?? (row?.defaultEffort && row.supportedEffortLevels?.includes(row.defaultEffort) ? row.defaultEffort : undefined)
  return { model, effort, serviceTier: resolveSupportedServiceTier(catalog, model, requested.serviceTier) ?? null }
}

export function codexConfigOptions(models: readonly SdkModelEntry[], currentModel: string): AgentConfigOption[] {
  if (models.length === 0) return []
  const modelId = codexAppServerModel(currentModel)
  return [
    modelConfigOption(models, currentModel),
    thoughtLevelConfigOption(models, modelId),
    serviceTierConfigOption(models, modelId),
  ].filter((option): option is AgentConfigOption => !!option)
}

function codexServiceTiers(value: unknown): SdkServiceTier[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const tier = asRecord(entry)
    const id = text(tier?.id)
    if (!id) return []
    const description = text(tier?.description)
    return [{ id, name: text(tier?.name) ?? id, ...(description ? { description } : {}) }]
  })
}

export async function fetchCodexModels(input: {
  directory?: string
  processObserver?: AgentProcessObserver
  ensureProcess: (directory: string) => Promise<CodexAppServerProcess>
}): Promise<SdkModelEntry[]> {
  const cwd = input.directory ?? process.cwd()
  const observation = observeAgentProcess(input.processObserver, {
    ownerId: `codex-probe:${randomUUID()}`,
    launchId: randomUUID(),
    harnessId: "codex",
    access: "native",
    role: "probe",
    label: "Codex model probe",
    locality: "in-process",
    confidence: "direct",
    capabilities: { resourceMetrics: "shared-process", ownerActions: false },
    directory: cwd,
  })
  observation.update({ lifecycle: "ready" })
  try {
    const proc = await input.ensureProcess(cwd)
    const models = new Map<string, SdkModelEntry>()
    let cursor: string | undefined
    do {
      const result = asRecord(await proc.request("model/list", cursor ? { cursor } : {}, controlRequestDeadline())) ?? {}
      const data = Array.isArray(result.data) ? result.data : []
      for (const item of data) {
        const row = asRecord(item)
        if (!row) continue
        const id = text(row.model) ?? text(row.id)
        if (!id || models.has(id)) continue
        const supportedEffortLevels = Array.isArray(row.supportedReasoningEfforts)
          ? row.supportedReasoningEfforts
            .map((option) => text(asRecord(option)?.reasoningEffort))
            .filter((effort): effort is string => !!effort)
          : []
        const serviceTiers = codexServiceTiers(row.serviceTiers)
        models.set(id, {
          id,
          name: text(row.displayName) ?? id,
          ...(text(row.description) ? { description: text(row.description)! } : {}),
          ...(row.isDefault === true ? { isDefault: true } : {}),
          ...(row.hidden === true ? { hidden: true } : {}),
          ...(supportedEffortLevels.length ? { supportsEffort: true, supportedEffortLevels } : {}),
          ...(text(row.defaultReasoningEffort) ? { defaultEffort: text(row.defaultReasoningEffort)! } : {}),
          ...(serviceTiers.length ? { serviceTiers } : {}),
        })
      }
      cursor = text(result.nextCursor)
    } while (cursor)
    return [...models.values()]
  } finally {
    observation.exit({ reason: "disposed" })
  }
}
