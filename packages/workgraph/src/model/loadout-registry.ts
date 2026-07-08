import { z } from "zod"
import type { IntakeItem, LoadoutKind, WorkItem } from "./types"

export interface LoadoutResolutionContext {
  type: "work_item" | "intake_item" | "system"
  item?: WorkItem
  intake?: IntakeItem
}

export interface LoadoutRegistryEntry {
  kind: LoadoutKind
  name: string
  schema: z.ZodType
  defaults: Record<string, unknown>
  selectName?: (ctx: LoadoutResolutionContext) => string
}

export interface RegisteredLoadout {
  name: string
  payload: Record<string, unknown>
}

const loadoutPayloadSchema = z.object({
  name: z.string(),
  overrides: z.record(z.string(), z.unknown()).nullable().optional(),
})

const registries = new Map<LoadoutKind, Map<string, LoadoutRegistryEntry>>()
const systemDefaults = new Map<LoadoutKind, string>()

export function registerLoadout(
  kind: LoadoutKind,
  name: string,
  schema: z.ZodType,
  defaults: Record<string, unknown>,
  opts: { systemDefault?: boolean; selectName?: (ctx: LoadoutResolutionContext) => string } = {},
) {
  const registry = registries.get(kind) ?? new Map<string, LoadoutRegistryEntry>()
  if (registry.has(name)) throw new Error(`Loadout '${kind}:${name}' is already registered`)
  registry.set(name, {
    kind,
    name,
    schema,
    defaults,
    selectName: opts.selectName,
  })
  registries.set(kind, registry)
  if (opts.systemDefault) systemDefaults.set(kind, name)
}

export function getLoadoutRegistryEntry(kind: LoadoutKind, name: string) {
  return registries.get(kind)?.get(name)
}

export function listLoadoutRegistryEntries(kind: LoadoutKind) {
  return Array.from(registries.get(kind)?.values() ?? [])
}

export function defaultLoadoutPayload(kind: LoadoutKind) {
  const name = systemDefaults.get(kind)
  if (!name) throw new Error(`No default loadout registered for '${kind}'`)
  return { name, overrides: null }
}

export function resolveRegisteredLoadout(
  kind: LoadoutKind,
  payload: unknown,
  ctx: LoadoutResolutionContext = { type: "system" },
): RegisteredLoadout {
  const parsed = loadoutPayloadSchema.parse(payload)
  const entry = getLoadoutRegistryEntry(kind, parsed.name)
  if (!entry) throw new Error(`Loadout '${kind}:${parsed.name}' is not registered`)
  const selectedName = entry.selectName?.(ctx)
  if (selectedName && selectedName !== parsed.name) {
    return resolveRegisteredLoadout(kind, { name: selectedName, overrides: parsed.overrides ?? null }, ctx)
  }
  return {
    name: entry.name,
    payload: entry.schema.parse({
      ...entry.defaults,
      ...(parsed.overrides ?? {}),
    }) as Record<string, unknown>,
  }
}
