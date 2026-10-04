import {
  CATALOG_HARNESS_IDS,
  isCatalogHarnessId,
  type HarnessSelection,
  type NativeHarnessId,
} from "@/lib/harness-selection"
import { harnessDisplayLabel } from "@/lib/harness-catalog"
import type { HarnessOptions, HarnessState } from "@/server"

export { harnessDisplayLabel } from "@/lib/harness-catalog"

export type HarnessType = HarnessSelection

export const DEFAULT_HARNESS_MODEL = { id: "default", name: "Default (recommended)" }

export { CATALOG_HARNESS_IDS, isCatalogHarnessId }

export function isCatalogHarness(type: HarnessType | undefined): boolean {
  return type?.kind === "native" && isCatalogHarnessId(type.harnessId)
}

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

export function isNativeSdkHarness(type: HarnessType) {
  return type.kind === "native" && ["claude", "codex", "cursor"].includes(type.harnessId)
}

const PI_PROVIDER_NAMES: Readonly<Record<string, string>> = {
  "openai-codex": "OpenAI Codex",
  openai: "OpenAI",
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  google: "Google",
  groq: "Groq",
  xai: "xAI",
}

export function harnessModelPickerProvider(harness: HarnessType, item: { id: string; providerId?: string }) {
  const harnessId = item.providerId ?? harnessSelectionId(harness)
  const label = harnessDisplayLabel(harnessId)
  if (!selectsNativeHarness(harness, "pi")) return { id: harnessId, name: label }
  const slash = item.id.indexOf("/")
  const provider = slash > 0 ? item.id.slice(0, slash) : harnessId
  return { id: harnessId, name: PI_PROVIDER_NAMES[provider] ?? harnessDisplayLabel(provider) }
}

export function selectsNativeHarness(type: HarnessType, id: NativeHarnessId): boolean {
  return type.kind === "native" && type.harnessId === id
}

export function harnessSelectionId(type: HarnessType) {
  return type.kind === "native" ? type.harnessId : type.connectionId
}

export function isStaticCatalogOptions(payload: Pick<HarnessOptions, "source" | "stale">) {
  return payload.source === "catalog" && payload.stale
}

export function isClientDefaultPlaceholder(model?: string | null) {
  return !model || model === DEFAULT_HARNESS_MODEL.id
}

export function hardFailedHarness(data: HarnessState) { return data.status === "error" || !!data.error }

export function failedHarness(data: HarnessState) { return hardFailedHarness(data) || data.ready === false }

