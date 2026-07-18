import { HARNESS_IDS, type HarnessId } from "@/platform/identity/session-ref"
import { HARNESS_DISPLAY_NAMES } from "@/ui/harness-display"

export { HARNESS_DISPLAY_NAMES } from "@/ui/harness-display"

export type HarnessType = HarnessId
export type OptionsSource = "harness" | "catalog" | "empty"
export type HarnessHealthStatus = "ok" | "degraded" | "unavailable"
export type HarnessHealth = { status?: HarnessHealthStatus; reason?: string }
export type HarnessState = { type?: HarnessType; binary?: string | null; model?: string | null; modelProviderID?: string | null; activeType?: HarnessType; activeBinary?: string | null; status?: "configured" | "ready" | "applying" | "error"; error?: string; ready?: boolean; workspaceId?: string; harnessHealth?: HarnessHealth }
export type HarnessConfigOption = { id: string; name: string; category?: string | null; type: "select" | "boolean"; currentValue: unknown; options?: Array<{ value: string; name: string; description?: string }>; selectOptions?: Array<{ id: string; name: string }> }
export type OptionsResponse = { options: HarnessConfigOption[]; source: OptionsSource; stale: boolean }

export const DEFAULT_HARNESS_MODEL = { id: "default", name: "Default (recommended)" }
const harnessStatuses = ["configured", "ready", "applying", "error"] as const

export function pickHarness(type?: string | null, binary?: string | null, access?: string | null): HarnessType | undefined {
  if (binary) {
    const name = (binary.includes("/") ? binary.split("/").pop()! : binary).replace(/\.exe$/i, "")
    if (name === "agent" || name === "cursor-agent" || name.includes("cursor")) return "cursor-acp"
    if (name.includes("codex")) return "codex-acp"
    if (name.includes("claude")) return "claude-acp"
  }
  if (access === "native") {
    if (type === "claude") return "claude-sdk"
    if (type === "codex") return "codex-app-server"
    if (type === "cursor") return "cursor-sdk"
    if (type === "opencode" || type === "pi") return type
  }
  if (access === "acp") {
    if (type === "claude") return "claude-acp"
    if (type === "codex") return "codex-acp"
    if (type === "cursor") return "cursor-acp"
  }
  if ((HARNESS_IDS as readonly string[]).includes(type ?? "")) return type as HarnessType
  return undefined
}

export function harnessHasConfigOptions(type: HarnessType) { return type !== "opencode" && type !== "pi" }

export function harnessProfile(id: HarnessType) {
  return {
    displayName: HARNESS_DISPLAY_NAMES[id] ?? id,
    hasConfigOptions: harnessHasConfigOptions(id),
  }
}

export function effectiveHarnessModel(type: HarnessType, selected?: string | null) {
  if (type === "opencode") return ""
  if (type === "pi") return selected || ""
  return selected || DEFAULT_HARNESS_MODEL.id
}

export function desiredHarness(data: HarnessState): HarnessType | undefined { return pickHarness(data.type, data.binary) }

export function activeHarness(data: HarnessState): HarnessType | undefined { return pickHarness(data.activeType ?? data.type, data.activeBinary ?? data.binary) }

export function hardFailedHarness(data: HarnessState) { return data.status === "error" || !!data.error }

export function failedHarness(data: HarnessState) { return hardFailedHarness(data) || data.ready === false }

export function extractModelsFromConfigOptions(
  options: HarnessConfigOption[],
): { models: { id: string; name: string }[]; currentModel?: string } | null {
  const opt = options.find((item) => item.category === "model" && item.type === "select")
  if (!opt) return null
  const models = opt.selectOptions?.length
    ? opt.selectOptions.map((item) => ({ ...item, id: normalizeHarnessModelId(item.id) }))
    : (opt.options ?? []).map((item) => ({ id: normalizeHarnessModelId(item.value), name: item.name }))
  if (models.length === 0) return null
  return {
    models,
    currentModel: typeof opt.currentValue === "string" ? normalizeHarnessModelId(opt.currentValue) : undefined,
  }
}

export function decodeHarnessState(value: unknown): HarnessState | undefined {
  const raw = record(value)
  if (!raw) return undefined
  const type = pickHarnessFromRecord(raw, "harness", "id", "type", "binary", "access")
  const activeType = pickHarnessFromRecord(raw, "activeHarness", "activeType", "activeType", "activeBinary", "activeAccess")
  const status = (harnessStatuses as readonly unknown[]).includes(raw.status) ? raw.status as HarnessState["status"] : undefined
  const binary = stringOrNull(raw.binary)
  const activeBinary = stringOrNull(raw.activeBinary)
  return {
    ...(type ? { type } : {}),
    ...(binary !== undefined ? { binary } : {}),
    ...(typeof raw.model === "string" || raw.model === null ? { model: raw.model } : {}),
    ...(typeof raw.modelProviderID === "string" || raw.modelProviderID === null ? { modelProviderID: raw.modelProviderID } : {}),
    ...(activeType ? { activeType } : {}),
    ...(activeBinary !== undefined ? { activeBinary } : {}),
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

function pickHarnessFromRecord(
  raw: Record<string, unknown>,
  harnessKey: string,
  primaryKey: string,
  fallbackKey: string,
  binaryKey: string,
  accessKey: string,
) {
  const harness = record(raw[harnessKey])
  return pickHarness(
    stringOrNull(raw[primaryKey]) ?? stringOrNull(raw[fallbackKey]) ?? stringOrNull(harness?.id),
    stringOrNull(raw[binaryKey]),
    stringOrNull(raw[accessKey]) ?? stringOrNull(harness?.access),
  )
}

export function decodeSessionConfig(value: unknown) {
  const raw = record(value)
  if (!raw) return {}
  const model = record(raw.model)
  return {
    harness: decodeHarnessState(raw.harness ?? raw.runner),
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
  const source = raw.source === "harness" || raw.source === "runner" || raw.source === "live"
    ? "harness"
    : raw.source === "catalog" || raw.source === "empty"
    ? raw.source
    : "empty"
  return {
    options: Array.isArray(raw.options) ? decodeConfigOptions(raw.options) : [],
    source,
    stale: raw.stale === true,
  }
}

function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined }

function stringOrNull(value: unknown): string | null | undefined { return typeof value === "string" || value === null ? value : undefined }

function normalizeHarnessModelId(value: string) {
  return value === "default[]" ? "default" : value
}

function decodeChoice(value: unknown): { value: string; name: string; description?: string } | undefined {
  const raw = record(value)
  if (!raw || typeof raw.value !== "string" || typeof raw.name !== "string") return undefined
  return {
    value: raw.value,
    name: raw.name,
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
  }
}

function decodeSelectOption(value: unknown): { id: string; name: string } | undefined {
  const raw = record(value)
  return raw && typeof raw.id === "string" && typeof raw.name === "string" ? { id: raw.id, name: raw.name } : undefined
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
