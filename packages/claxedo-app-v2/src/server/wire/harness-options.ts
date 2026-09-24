import { ServerError } from "../errors"
import type { HarnessModel, HarnessOptions, ModelChoice } from "../types"

type ConfigOption = { readonly category?: unknown; readonly type?: unknown; readonly currentValue?: unknown; readonly selectOptions?: unknown; readonly options?: unknown }
type Choice = { readonly id: string; readonly name: string; readonly connected: boolean; readonly efforts: readonly string[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function choiceOf(value: unknown): Choice | undefined {
  if (!isRecord(value)) return undefined
  const id = typeof value.id === "string" ? value.id : typeof value.value === "string" ? value.value : undefined
  if (!id) return undefined
  return { id, name: typeof value.name === "string" ? value.name : id, connected: value.connected !== false, efforts: strings(value.supportedEffortLevels) }
}

function choices(option: ConfigOption | undefined): readonly Choice[] {
  if (!option) return []
  const listed = Array.isArray(option.selectOptions) && option.selectOptions.length > 0 ? option.selectOptions : option.options
  return Array.isArray(listed) ? listed.flatMap((item) => {
    const choice = choiceOf(item)
    return choice ? [choice] : []
  }) : []
}

export function harnessOptionsFromWire(body: unknown, harness: string): HarnessOptions {
  const options = isRecord(body) ? body.options : undefined
  if (!Array.isArray(options)) throw new ServerError({ class: "internal", message: `The ${harness} options answered without options` })
  const select = (category: string) => options.find((item): item is ConfigOption => isRecord(item) && item.category === category && item.type === "select")
  const modelOption = select("model")
  const modelOf = (modelId: string): ModelChoice => ({ providerId: harness, modelId })
  const models: HarnessModel[] = choices(modelOption).map((choice) => ({ model: modelOf(choice.id), name: choice.name, connected: choice.connected, efforts: choice.efforts }))
  const current = typeof modelOption?.currentValue === "string" ? modelOf(modelOption.currentValue) : undefined
  return { models, ...(current ? { current } : {}), efforts: choices(select("thought_level")).map((choice) => choice.id) }
}
