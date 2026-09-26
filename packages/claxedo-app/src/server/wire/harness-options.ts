import type { HarnessOptionChoice, HarnessOptions, HarnessOptionSelect, HarnessOptionsSource } from "../harness-types"
import { isRecord } from "../../lib/record"

type ConfigOption = { readonly category: unknown; readonly type: unknown; readonly currentValue: unknown; readonly options: unknown; readonly selectOptions: unknown }

function selectOption(value: unknown): HarnessOptionChoice | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") return undefined
  return {
    id: value.id,
    name: value.name,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.connected === "boolean" ? { connected: value.connected } : {}),
  }
}

function acpChoice(value: unknown): HarnessOptionChoice | undefined {
  if (!isRecord(value) || typeof value.value !== "string" || typeof value.name !== "string") return undefined
  return { id: value.value, name: value.name, ...(typeof value.description === "string" ? { description: value.description } : {}) }
}

function decoded(values: unknown, decode: (value: unknown) => HarnessOptionChoice | undefined): readonly HarnessOptionChoice[] {
  return Array.isArray(values) ? values.flatMap((value) => decode(value) ?? []) : []
}

function configOptions(values: readonly unknown[]): readonly ConfigOption[] {
  return values.filter((value): value is ConfigOption & Record<string, unknown> =>
    isRecord(value) && typeof value.id === "string" && typeof value.name === "string" && (value.type === "select" || value.type === "boolean"))
}

function select(options: readonly ConfigOption[], category: string): HarnessOptionSelect | undefined {
  const option = options.find((item) => item.category === category && item.type === "select")
  if (!option) return undefined
  const native = decoded(option.selectOptions, selectOption)
  const choices = native.length > 0 ? native : decoded(option.options, acpChoice)
  return { choices, ...(typeof option.currentValue === "string" ? { current: option.currentValue } : {}) }
}

function source(value: unknown): HarnessOptionsSource {
  return value === "harness" || value === "catalog" ? value : "empty"
}

export function harnessOptionsFromWire(body: unknown): HarnessOptions {
  if (!Array.isArray(body) && !isRecord(body)) return { source: "empty", stale: true, offersOptions: false, serviceTiers: [] }
  const options = configOptions(Array.isArray(body) ? body : Array.isArray(body.options) ? body.options : [])
  const resolvedModel = isRecord(body) ? selectOption(body.resolvedModel) : undefined
  const live = Array.isArray(body) || (body.source === undefined && body.stale === undefined)
  const models = select(options, "model")
  const thoughtLevels = select(options, "thought_level")
  return {
    source: live ? "harness" : source(body.source),
    stale: live ? false : body.stale === true,
    offersOptions: options.length > 0,
    ...(models && models.choices.length > 0 ? { models } : {}),
    ...(thoughtLevels && thoughtLevels.choices.length > 1 ? { thoughtLevels } : {}),
    serviceTiers: decoded(options.find((item) => item.category === "service_tier" && item.type === "select")?.selectOptions, selectOption),
    ...(resolvedModel ? { resolvedModel } : {}),
  }
}
