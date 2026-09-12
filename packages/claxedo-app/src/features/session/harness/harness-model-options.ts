import { asRecord, readString } from "@/lib/record"
import { authFetch } from "@/platform/api/api"
import { createHarnessConfigRuntime } from "./harness-config-runtime"
import type { HarnessScopeInput } from "./controller"
import {
  extractModelsFromConfigOptions,
  harnessModelPickerProvider,
  optionsResponse,
  type HarnessModelOption,
  type HarnessType,
} from "./profile"

export type HarnessModelGroup = {
  /** Distinct per (provider id, provider name): Pi reports every model under its own id but labels them by vendor. */
  key: string
  providerId: string
  providerName: string
  items: HarnessModelOption[]
}

/** The models one harness reports, grouped under the provider the composer's picker would show them with. */
export function groupHarnessModels(harness: HarnessType, models: readonly HarnessModelOption[]): HarnessModelGroup[] {
  const groups = new Map<string, HarnessModelGroup>()
  for (const model of models) {
    const provider = harnessModelPickerProvider(harness, model)
    const key = `${provider.id}\n${provider.name}`
    const group = groups.get(key) ?? { key, providerId: provider.id, providerName: provider.name, items: [] }
    group.items.push(model)
    groups.set(key, group)
  }
  return [...groups.values()]
}

async function optionsError(res: Response) {
  const body = asRecord(await res.json().catch(() => undefined))
  return readString(body, "error")
    ?? readString(asRecord(body?.error), "message")
    ?? `Harness options request failed (${res.status})`
}

/**
 * The model list a harness reports for a workspace, read from the same
 * options endpoint the composer's picker reads, over the same local-or-relay
 * transport. Empty when the harness answered without a model option.
 */
export async function loadHarnessModelOptions(input: {
  serverUrl: string
  scope: HarnessScopeInput
  harness: HarnessType
  projects: Parameters<typeof createHarnessConfigRuntime>[0]["projects"]
}): Promise<HarnessModelOption[]> {
  const runtime = createHarnessConfigRuntime({ base: input.serverUrl, request: authFetch, projects: input.projects })
  const res = await runtime.configOptionsFetch(input.harness, input.scope)
  if (!res.ok) throw new Error(await optionsError(res))
  return extractModelsFromConfigOptions(optionsResponse(await res.json()).options)?.models ?? []
}
