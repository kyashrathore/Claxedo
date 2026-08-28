import { HARNESS_IDS, isAcpConnectionHarnessId, type HarnessId } from "@/platform/identity/session-ref"
import { HARNESS_DISPLAY_NAMES, harnessDisplayLabel } from "@/ui/harness-display"

export { HARNESS_DISPLAY_NAMES, harnessDisplayLabel } from "@/ui/harness-display"

export type HarnessType = HarnessId
export type OptionsSource = "harness" | "catalog" | "empty"
export type HarnessHealthStatus = "ok" | "degraded" | "unavailable"
export type HarnessHealth = { status?: HarnessHealthStatus; reason?: string }
export type HarnessState = { type?: HarnessType; binary?: string | null; model?: string | null; modelProviderID?: string | null; activeType?: HarnessType; activeBinary?: string | null; status?: "configured" | "ready" | "applying" | "error"; error?: string; ready?: boolean; workspaceId?: string; harnessHealth?: HarnessHealth }
/** A model choice offered by a harness. `description` carries the version and
 * context window (e.g. "Opus 4.8 with 1M context"), which `name` omits. */
export type HarnessModelOption = { id: string; name: string; description?: string }
export type HarnessConfigOption = { id: string; name: string; category?: string | null; type: "select" | "boolean"; currentValue: unknown; options?: Array<{ value: string; name: string; description?: string }>; selectOptions?: Array<HarnessModelOption> }
export type OptionsResponse = { options: HarnessConfigOption[]; source: OptionsSource; stale: boolean }

export const DEFAULT_HARNESS_MODEL = { id: "default", name: "Default (recommended)" }
const harnessStatuses = ["configured", "ready", "applying", "error"] as const

export function pickHarness(type?: string | null, binary?: string | null, access?: string | null): HarnessType | undefined {
  // An explicit operator-ACP identity wins BEFORE binary sniffing: a custom
  // connection whose command happens to contain "claude"/"codex"/"cursor" must
  // never be misread as a built-in.
  if (type && isAcpConnectionHarnessId(type)) return type
  if (access === "acp" && type && isAcpConnectionHarnessId(`acp:${type}`) &&
    type !== "claude" && type !== "codex" && type !== "cursor") {
    return `acp:${type}`
  }
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
    displayName: harnessDisplayLabel(id),
    hasConfigOptions: harnessHasConfigOptions(id),
  }
}

export function sessionHarnessIdentity(type: HarnessType) {
  if (type.startsWith("acp:")) return { id: type.slice(4), access: "acp" as const }
  if (type === "claude-acp") return { id: "claude", access: "acp" as const }
  if (type === "codex-acp") return { id: "codex", access: "acp" as const }
  if (type === "cursor-acp") return { id: "cursor", access: "acp" as const }
  if (type === "claude-sdk") return { id: "claude", access: "native" as const }
  if (type === "codex-app-server") return { id: "codex", access: "native" as const }
  if (type === "cursor-sdk") return { id: "cursor", access: "native" as const }
  return { id: type, access: "native" as const }
}

export function effectiveHarnessModel(type: HarnessType, selected?: string | null) {
  if (type === "opencode") return ""
  if (type === "pi") return selected || ""
  return selected || DEFAULT_HARNESS_MODEL.id
}

/** Native SDK harnesses that can be backstopped with a static catalog when live listing fails. */
export function isNativeSdkHarness(type: HarnessType) {
  return type === "claude-sdk" || type === "codex-app-server" || type === "cursor-sdk"
}

export function isStaticCatalogOptions(payload: Pick<OptionsResponse, "source" | "stale">) {
  return payload.source === "catalog" && payload.stale
}

export function isClientDefaultPlaceholder(model?: string | null) {
  return !model || model === DEFAULT_HARNESS_MODEL.id
}

export function desiredHarness(data: HarnessState): HarnessType | undefined { return pickHarness(data.type, data.binary) }

export function activeHarness(data: HarnessState): HarnessType | undefined { return pickHarness(data.activeType ?? data.type, data.activeBinary ?? data.binary) }

export function hardFailedHarness(data: HarnessState) { return data.status === "error" || !!data.error }

export function failedHarness(data: HarnessState) { return hardFailedHarness(data) || data.ready === false }

export function extractModelsFromConfigOptions(
  options: HarnessConfigOption[],
): { models: HarnessModelOption[]; currentModel?: string } | null {
  const opt = options.find((item) => item.category === "model" && item.type === "select")
  if (!opt) return null
  const models = opt.selectOptions?.length
    ? opt.selectOptions.map((item) => ({ ...item, id: normalizeHarnessModelId(item.id) }))
    : (opt.options ?? []).map((item) => ({
        id: normalizeHarnessModelId(item.value),
        name: item.name,
        ...(item.description ? { description: item.description } : {}),
      }))
  if (models.length === 0) return null
  return {
    models,
    currentModel: typeof opt.currentValue === "string" ? normalizeHarnessModelId(opt.currentValue) : undefined,
  }
}

/**
 * The harness's reasoning/thinking-effort choice, when it offers one.
 *
 * `thought_level` is a first-class category in the ACP schema alongside `mode`
 * and `model`, and both bundled agents already emit it — codex-acp as
 * "Reasoning effort", claude-agent-acp as "Effort" with a leading `default`
 * row. Native SDK harnesses report the same category through the same channel;
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

function decodeSelectOption(value: unknown): { id: string; name: string; description?: string } | undefined {
  const raw = record(value)
  if (!raw || typeof raw.id !== "string" || typeof raw.name !== "string") return undefined
  return {
    id: raw.id,
    name: raw.name,
    // Harness display names are short marketing labels ("Sonnet", "Opus"); the
    // version and context window only live in the description, so keep it.
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
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
