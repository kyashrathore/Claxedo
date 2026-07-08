// target-layer: session-client
import type { HarnessId } from "../../shell/identity/session-ref"

export type HarnessType = HarnessId
export type OptionsSource = "harness" | "catalog" | "empty"
export type HarnessState = { type?: HarnessType; binary?: string | null; model?: string | null; activeType?: HarnessType; activeBinary?: string | null; status?: "configured" | "ready" | "applying" | "error"; error?: string; ready?: boolean; workspaceId?: string }
export type HarnessConfigOption = { id: string; name: string; category?: string | null; type: "select" | "boolean"; currentValue: unknown; options?: Array<{ value: string; name: string; description?: string }>; selectOptions?: Array<{ id: string; name: string }> }
export type OptionsResponse = { options: HarnessConfigOption[]; source: OptionsSource; stale: boolean }

export const HARNESS_DISPLAY_NAMES: Record<string, string> = {
  "claude-agent-acp": "Claude", "claude-acp": "Claude", "codex-acp": "Codex", "claude-sdk": "Claude SDK", "codex-app-server": "Codex App Server", "cursor-sdk": "Cursor SDK", agent: "Cursor", "cursor-agent": "Cursor", "cursor-acp": "Cursor", opencode: "OpenCode", pi: "Pi",
}

export const DEFAULT_HARNESS_MODEL = { id: "default", name: "Default (recommended)" }
const HARNESS_IDS = ["claude-acp", "codex-acp", "cursor-acp", "claude-sdk", "codex-app-server", "cursor-sdk", "opencode", "pi"] as const
const harnessStatuses = ["configured", "ready", "applying", "error"] as const

export function pickHarness(type?: string | null, binary?: string | null): HarnessType | undefined {
  if (binary) {
    const name = (binary.includes("/") ? binary.split("/").pop()! : binary).replace(/\.exe$/i, "")
    if (name === "agent" || name === "cursor-agent" || name.includes("cursor")) return "cursor-acp"
    if (name.includes("codex")) return "codex-acp"
    if (name.includes("claude")) return "claude-acp"
  }
  if ((HARNESS_IDS as readonly string[]).includes(type ?? "")) return type as HarnessType
  return undefined
}

export function harnessHasConfigOptions(type: HarnessType) { return type !== "opencode" && type !== "pi" }

export function fixedHarnessModel(type: HarnessType) { return type === "pi" ? { id: "virtual", name: "Virtual", provider: { id: "pi" } } : undefined }

export function harnessProfile(id: HarnessType) {
  const fixedModel = fixedHarnessModel(id)
  return {
    displayName: HARNESS_DISPLAY_NAMES[id] ?? id,
    hasConfigOptions: harnessHasConfigOptions(id),
    ...(fixedModel ? { fixedModel } : {}),
  }
}

export function effectiveHarnessModel(type: HarnessType, selected?: string | null) { return harnessHasConfigOptions(type) ? selected || DEFAULT_HARNESS_MODEL.id : "" }

export function desiredHarness(data: HarnessState): HarnessType | undefined { return pickHarness(data.type, data.binary) }

export function activeHarness(data: HarnessState): HarnessType | undefined { return pickHarness(data.activeType ?? data.type, data.activeBinary ?? data.binary) }

export function failedHarness(data: HarnessState) { return data.status === "error" || !!data.error }

export function extractModelsFromConfigOptions(
  options: HarnessConfigOption[],
): { models: { id: string; name: string }[]; currentModel?: string } | null {
  const opt = options.find((item) => item.category === "model" && item.type === "select")
  if (!opt) return null
  const models = opt.selectOptions?.length
    ? opt.selectOptions
    : (opt.options ?? []).map((item) => ({ id: item.value, name: item.name }))
  if (models.length === 0) return null
  return { models, currentModel: typeof opt.currentValue === "string" ? opt.currentValue : undefined }
}

export function decodeHarnessState(value: unknown): HarnessState | undefined {
  const raw = record(value)
  if (!raw) return undefined
  const type = pickHarness(typeof raw.id === "string" ? raw.id : typeof raw.type === "string" ? raw.type : undefined, stringOrNull(raw.binary))
  const activeType = pickHarness(typeof raw.activeType === "string" ? raw.activeType : undefined, stringOrNull(raw.activeBinary))
  const status = (harnessStatuses as readonly unknown[]).includes(raw.status) ? raw.status as HarnessState["status"] : undefined
  const binary = stringOrNull(raw.binary)
  const activeBinary = stringOrNull(raw.activeBinary)
  return {
    ...(type ? { type } : {}),
    ...(binary !== undefined ? { binary } : {}),
    ...(typeof raw.model === "string" || raw.model === null ? { model: raw.model } : {}),
    ...(activeType ? { activeType } : {}),
    ...(activeBinary !== undefined ? { activeBinary } : {}),
    ...(status ? { status } : {}),
    ...(typeof raw.error === "string" ? { error: raw.error } : {}),
    ...(typeof raw.ready === "boolean" ? { ready: raw.ready } : {}),
    ...(typeof raw.workspaceId === "string" ? { workspaceId: raw.workspaceId } : {}),
  }
}

export function decodeSessionConfig(value: unknown) {
  const raw = record(value)
  if (!raw) return {}
  const model = record(raw.model)
  return { harness: decodeHarnessState(raw.harness ?? raw.runner), model: model && (typeof model.modelID === "string" || model.modelID === null) ? { modelID: model.modelID } : null }
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
