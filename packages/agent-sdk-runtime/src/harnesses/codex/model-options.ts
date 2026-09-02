import { randomUUID } from "crypto"
import type { AgentConfigOption } from "../../index"
import type { AgentProcessObserver } from "../../process-observer"
import { observeAgentProcess } from "../../process-observer"
import {
  modelConfigOption,
  thoughtLevelConfigOption,
  type SdkModelEntry,
} from "../../sdk-model-catalog"
import { record, text } from "../shared/sdk-runtime-adapter"
import type { CodexAppServerProcess } from "./app-server-process"
import { codexAppServerModel } from "./protocol"

export function codexConfigOptions(models: readonly SdkModelEntry[], currentModel: string): AgentConfigOption[] {
  if (models.length === 0) return []
  const effort = thoughtLevelConfigOption(models, codexAppServerModel(currentModel), undefined)
  return effort
    ? [modelConfigOption(models, currentModel), effort]
    : [modelConfigOption(models, currentModel)]
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
      const result = record(await proc.request("model/list", cursor ? { cursor } : {})) ?? {}
      const data = Array.isArray(result.data) ? result.data : []
      for (const item of data) {
        const row = record(item)
        if (!row || row.hidden === true) continue
        const id = text(row.model) ?? text(row.id)
        if (!id || models.has(id)) continue
        const supportedEffortLevels = Array.isArray(row.supportedReasoningEfforts)
          ? row.supportedReasoningEfforts
            .map((option) => text(record(option)?.reasoningEffort))
            .filter((effort): effort is string => !!effort)
          : []
        models.set(id, {
          id,
          name: text(row.displayName) ?? id,
          ...(text(row.description) ? { description: text(row.description)! } : {}),
          ...(row.isDefault === true ? { isDefault: true } : {}),
          ...(supportedEffortLevels.length ? { supportsEffort: true, supportedEffortLevels } : {}),
          ...(text(row.defaultReasoningEffort) ? { defaultEffort: text(row.defaultReasoningEffort)! } : {}),
        })
      }
      cursor = text(result.nextCursor)
    } while (cursor)
    return [...models.values()]
  } finally {
    observation.exit({ reason: "disposed" })
  }
}
