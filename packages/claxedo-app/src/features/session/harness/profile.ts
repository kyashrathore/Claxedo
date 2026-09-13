import {
  CATALOG_HARNESS_IDS,
  isCatalogHarnessId,
  isHarnessSelection,
  type HarnessSelection,
  type NativeHarnessId,
} from "@/platform/identity/harness-selection"
import { harnessDisplayLabel } from "@/platform/identity/harness-catalog"

export { harnessDisplayLabel } from "@/platform/identity/harness-catalog"

export type HarnessType = HarnessSelection
export type OptionsSource = "harness" | "catalog" | "empty"
export type HarnessHealthStatus = "ok" | "degraded" | "unavailable"
export type HarnessHealth = { status?: HarnessHealthStatus; reason?: string }
export type HarnessState = { type?: HarnessType; model?: string | null; modelProviderID?: string | null; activeType?: HarnessType; status?: "configured" | "ready" | "applying" | "error"; error?: string; ready?: boolean; workspaceId?: string; harnessHealth?: HarnessHealth }
/** A model choice offered by a harness. `description` carries the version and
 * context window (e.g. "Opus 4.8 with 1M context"), which `name` omits. */
export type HarnessModelOption = { id: string; name: string; description?: string; connected?: boolean }
export type HarnessConfigOption = { id: string; name: string; category?: string | null; type: "select" | "boolean"; currentValue: unknown; options?: Array<{ value: string; name: string; description?: string }>; selectOptions?: Array<HarnessModelOption> }
/**
 * A config-options answer, from either producer.
 *
 * `resolvedModel` is the model the harness reports as current for its next
 * turn, in the harness's own vocabulary. It is ABSENT whenever the harness
 * named no current model — never a guess and never a catalog default.
 */
export type OptionsResponse = {
  options: HarnessConfigOption[]
  source: OptionsSource
  stale: boolean
  resolvedModel?: HarnessModelOption
}

export const DEFAULT_HARNESS_MODEL = { id: "default", name: "Default (recommended)" }
const harnessStatuses = ["configured", "ready", "applying", "error"] as const

export function pickHarness(input?: unknown): HarnessType | undefined {
  if (isHarnessSelection(input)) return input
  const row = record(input)
  if (!row || typeof row.id !== "string" || !row.id.trim()) return undefined
  if (row.access === "connection") return { kind: "connection", connectionId: row.id }
  if (row.access === "native" && (row.id === "claude" || row.id === "codex" || row.id === "cursor" || row.id === "pi" || row.id === "opencode")) {
    return { kind: "native", harnessId: row.id }
  }
  return undefined
}

export { CATALOG_HARNESS_IDS, isCatalogHarnessId }

/** Whether a harness selection reads the Claxedo provider catalog (see `CATALOG_HARNESS_IDS`). */
export function isCatalogHarness(type: HarnessType | undefined): boolean {
  return type?.kind === "native" && isCatalogHarnessId(type.harnessId)
}

/** The catalog a harness selection reads, when it reads one. */
export function catalogHarnessId(type: HarnessType | undefined) {
  return type?.kind === "native" && isCatalogHarnessId(type.harnessId) ? type.harnessId : undefined
}

export function harnessHasConfigOptions(type: HarnessType) {
  return !isCatalogHarness(type)
}

export function harnessProfile(id: HarnessType) {
  return {
    displayName: harnessDisplayLabel(harnessSelectionId(id)),
    hasConfigOptions: harnessHasConfigOptions(id),
  }
}

export function sessionHarnessIdentity(type: HarnessType) {
  return type.kind === "native"
    ? { id: type.harnessId, access: "native" as const }
    : { id: type.connectionId, access: "connection" as const }
}



/** Native SDK harnesses that can be backstopped with a static catalog when live listing fails. */
export function isNativeSdkHarness(type: HarnessType) {
  return type.kind === "native" && ["claude", "codex", "cursor"].includes(type.harnessId)
}

/**
 * The provider row a harness-reported model is shown under. Every harness but
 * Pi is its own provider; Pi reports `vendor/model` ids and keeps its own id as
 * the key while labelling the group by vendor.
 */
export function harnessModelPickerProvider(harness: HarnessType, item: { id: string; providerID?: string }) {
  const harnessId = item.providerID ?? harnessSelectionId(harness)
  const label = harnessDisplayLabel(harnessId)
  if (!isNativeHarness(harness, "pi")) return { id: harnessId, name: label }
  const slash = item.id.indexOf("/")
  const provider = slash > 0 ? item.id.slice(0, slash) : harnessId
  return {
    id: harnessId,
    name: provider
      .split(/[-_]/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" "),
  }
}

export function isNativeHarness(type: HarnessType, id: NativeHarnessId): boolean {
  return type.kind === "native" && type.harnessId === id
}

export function harnessSelectionId(type: HarnessType) {
  return type.kind === "native" ? type.harnessId : type.connectionId
}

export function isStaticCatalogOptions(payload: Pick<OptionsResponse, "source" | "stale">) {
  return payload.source === "catalog" && payload.stale
}

export function isClientDefaultPlaceholder(model?: string | null) {
  return !model || model === DEFAULT_HARNESS_MODEL.id
}

export function desiredHarness(data: HarnessState): HarnessType | undefined { return pickHarness(data.type) }

export function activeHarness(data: HarnessState): HarnessType | undefined { return pickHarness(data.activeType ?? data.type) }

export function hardFailedHarness(data: HarnessState) { return data.status === "error" || !!data.error }

export function failedHarness(data: HarnessState) { return hardFailedHarness(data) || data.ready === false }

export function extractModelsFromConfigOptions(
  options: HarnessConfigOption[],
): { models: HarnessModelOption[]; currentModel?: string } | null {
  const opt = options.find((item) => item.category === "model" && item.type === "select")
  if (!opt) return null
  const models = opt.selectOptions?.length
    ? opt.selectOptions
    : (opt.options ?? []).map((item) => ({
        id: item.value,
        name: item.name,
        ...(item.description ? { description: item.description } : {}),
      }))
  if (models.length === 0) return null
  return {
    models,
    currentModel: typeof opt.currentValue === "string" ? opt.currentValue : undefined,
  }
}

/**
 * The harness's reasoning/thinking-effort choice, when it offers one.
 *
 * `thought_level` is a first-class category in the ACP schema alongside `mode`
 * and `model`. Native SDK harnesses report the same category through the same channel;
 * the Claude SDK's `ModelInfo` carries `supportedEffortLevels` PER MODEL, which
 * is why this is re-derived whenever the option payload changes rather than
 * cached against the harness.
 *
 * Mirrors `extractModelsFromConfigOptions` deliberately, including the
 * `selectOptions` vs `options` split: ACP sends `options` (`value`/`name`),
 * the native SDK path sends `selectOptions` (`id`/`name`).
 *
 * Returns null when the harness offers no such option OR offers exactly one
 * level — a single choice is not a choice, and surfacing it would spend a whole
 * disclosure section on something the user cannot change.
 */
export function extractThoughtLevelFromConfigOptions(
  options: HarnessConfigOption[],
): { levels: HarnessModelOption[]; current?: string } | null {
  const opt = options.find((item) => item.category === "thought_level" && item.type === "select")
  if (!opt) return null
  const levels = opt.selectOptions?.length
    ? opt.selectOptions.map((item) => ({ ...item }))
    : (opt.options ?? []).map((item) => ({
        id: item.value,
        name: item.name,
        ...(item.description ? { description: item.description } : {}),
      }))
  if (levels.length < 2) return null
  return {
    levels,
    ...(typeof opt.currentValue === "string" ? { current: opt.currentValue } : {}),
  }
}

/** Sound because `harnessStatuses` IS the `HarnessState["status"]` union. */
function isHarnessStatus(value: unknown): value is NonNullable<HarnessState["status"]> {
  return (harnessStatuses as readonly unknown[]).includes(value)
}

export function decodeHarnessState(value: unknown): HarnessState | undefined {
  const raw = record(value)
  if (!raw) return undefined
  const type = pickHarness(raw.harness)
  const activeType = pickHarness(raw.activeHarness)
  const status = isHarnessStatus(raw.status) ? raw.status : undefined
  return {
    ...(type ? { type } : {}),
    ...(typeof raw.model === "string" || raw.model === null ? { model: raw.model } : {}),
    ...(typeof raw.modelProviderID === "string" || raw.modelProviderID === null ? { modelProviderID: raw.modelProviderID } : {}),
    ...(activeType ? { activeType } : {}),
    ...(status ? { status } : {}),
    ...(typeof raw.error === "string" ? { error: raw.error } : {}),
    ...(typeof raw.ready === "boolean" ? { ready: raw.ready } : {}),
    ...(typeof raw.workspaceId === "string" ? { workspaceId: raw.workspaceId } : {}),
    ...(decodeHarnessHealth(raw.harnessHealth) ? { harnessHealth: decodeHarnessHealth(raw.harnessHealth)! } : {}),
  }
}

function decodeHarnessHealth(value: unknown): HarnessHealth | undefined {
  const raw = record(value)
  if (!raw) return undefined
  const status = raw.status === "ok" || raw.status === "degraded" || raw.status === "unavailable" ? raw.status : undefined
  if (!status) return undefined
  return {
    status,
    ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
  }
}

export function decodeSessionConfig(value: unknown) {
  const raw = record(value)
  if (!raw) return {}
  const model = record(raw.model)
  return {
    harness: decodeHarnessState({ harness: raw.harness, activeHarness: raw.harness }),
    model: model && (typeof model.modelID === "string" || model.modelID === null)
      ? {
          modelID: model.modelID,
          ...(typeof model.providerID === "string" || model.providerID === null ? { providerID: model.providerID } : {}),
        }
      : null,
  }
}

export function optionsResponse(value: unknown): OptionsResponse {
  if (Array.isArray(value)) {
    return { options: decodeConfigOptions(value), source: "harness", stale: false }
  }
  const raw = record(value)
  if (!raw) return { options: [], source: "empty", stale: true }
  const resolvedModel = decodeSelectOption(raw.resolvedModel)
  const options = Array.isArray(raw.options) ? decodeConfigOptions(raw.options) : []
  const model = resolvedModel ? { resolvedModel } : {}
  // The workspace runtime answers `AgentConfigOptions` — `{options, resolvedModel?}`
  // with no freshness of its own, because it asked the harness just now. The
  // daemon route wraps the same payload in its own `source`/`stale` bookkeeping,
  // so only an answer that declares neither is the runtime's, and it is live.
  if (raw.source === undefined && raw.stale === undefined) {
    return { options, source: "harness", stale: false, ...model }
  }
  const source = raw.source === "harness"
    ? "harness"
    : raw.source === "catalog" || raw.source === "empty"
    ? raw.source
    : "empty"
  return {
    options,
    source,
    stale: raw.stale === true,
    ...model,
  }
}

function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined }

function decodeChoice(value: unknown): { value: string; name: string; description?: string } | undefined {
  const raw = record(value)
  if (!raw || typeof raw.value !== "string" || typeof raw.name !== "string") return undefined
  return {
    value: raw.value,
    name: raw.name,
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
  }
}

function decodeSelectOption(value: unknown): { id: string; name: string; description?: string } | undefined {
  const raw = record(value)
  if (!raw || typeof raw.id !== "string" || typeof raw.name !== "string") return undefined
  return {
    id: raw.id,
    name: raw.name,
    // Harness display names are short marketing labels ("Sonnet", "Opus"); the
    // version and context window only live in the description, so keep it.
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    ...(typeof raw.connected === "boolean" ? { connected: raw.connected } : {}),
  }
}

function decodeConfigOptions(values: unknown[]) {
  return values.map(decodeConfigOption).filter((item): item is HarnessConfigOption => !!item)
}

function decodeConfigOption(value: unknown): HarnessConfigOption | undefined {
  const raw = record(value)
  if (!raw || typeof raw.id !== "string" || typeof raw.name !== "string") return undefined
  if (raw.type !== "select" && raw.type !== "boolean") return undefined
  const options = Array.isArray(raw.options) ? raw.options.map(decodeChoice).filter((item): item is NonNullable<typeof item> => !!item) : undefined
  const selectOptions = Array.isArray(raw.selectOptions) ? raw.selectOptions.map(decodeSelectOption).filter((item): item is NonNullable<typeof item> => !!item) : undefined
  return {
    id: raw.id,
    name: raw.name,
    type: raw.type,
    currentValue: raw.currentValue,
    ...(typeof raw.category === "string" || raw.category === null ? { category: raw.category } : {}),
    ...(options ? { options } : {}),
    ...(selectOptions ? { selectOptions } : {}),
  }
}
