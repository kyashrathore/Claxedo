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

/** Native SDK harnesses that can be backstopped with a static catalog when live listing fails. */
export function isNativeSdkHarness(type: HarnessType) {
  return type.kind === "native" && ["claude", "codex", "cursor"].includes(type.harnessId)
}

/**
 * The provider row a harness-reported model is shown under. Every harness but
 * Pi is its own provider; Pi reports `vendor/model` ids and keeps its own id as
 * the key while labelling the group by vendor.
 */
export function harnessModelPickerProvider(harness: HarnessType, item: { id: string; providerId?: string }) {
  const harnessId = item.providerId ?? harnessSelectionId(harness)
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

export function isStaticCatalogOptions(payload: Pick<HarnessOptions, "source" | "stale">) {
  return payload.source === "catalog" && payload.stale
}

export function isClientDefaultPlaceholder(model?: string | null) {
  return !model || model === DEFAULT_HARNESS_MODEL.id
}

export function hardFailedHarness(data: HarnessState) { return data.status === "error" || !!data.error }

export function failedHarness(data: HarnessState) { return hardFailedHarness(data) || data.ready === false }

