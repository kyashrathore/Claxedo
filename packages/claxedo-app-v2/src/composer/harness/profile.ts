import {
  CATALOG_HARNESS_IDS,
  isCatalogHarnessId,
  isHarnessSelection,
  type HarnessSelection,
  type NativeHarnessId,
} from "@/lib/harness-selection"
import { harnessDisplayLabel } from "@/lib/harness-catalog"
import type { HarnessOptions } from "@/server"

export { harnessDisplayLabel } from "@/lib/harness-catalog"

export type HarnessType = HarnessSelection
export type HarnessHealthStatus = "ok" | "degraded" | "unavailable"
export type HarnessHealth = { status?: HarnessHealthStatus; reason?: string }
export type HarnessConnectionState = { connectionId: string; state: "configured" | "connecting" | "ready" | "auth-required" | "disconnected" | "failed" }
/** `thoughtLevel` is the effort a bound session saved; only its config carries one. */
export type HarnessState = { type?: HarnessType; model?: string | null; modelProviderId?: string | null; thoughtLevel?: string; activeType?: HarnessType; status?: "configured" | "ready" | "applying" | "error"; error?: string; ready?: boolean; workspaceId?: string; harnessHealth?: HarnessHealth; connectionState?: HarnessConnectionState }

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

export function desiredHarness(data: HarnessState): HarnessType | undefined { return pickHarness(data.type) }

export function hardFailedHarness(data: HarnessState) { return data.status === "error" || !!data.error }

export function failedHarness(data: HarnessState) { return hardFailedHarness(data) || data.ready === false }

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
    ...(typeof raw.modelProviderID === "string" || raw.modelProviderID === null ? { modelProviderId: raw.modelProviderID } : {}),
    ...(activeType ? { activeType } : {}),
    ...(status ? { status } : {}),
    ...(typeof raw.error === "string" ? { error: raw.error } : {}),
    ...(typeof raw.ready === "boolean" ? { ready: raw.ready } : {}),
    ...(typeof raw.workspaceId === "string" ? { workspaceId: raw.workspaceId } : {}),
    ...(decodeHarnessHealth(raw.harnessHealth) ? { harnessHealth: decodeHarnessHealth(raw.harnessHealth)! } : {}),
    ...(decodeConnectionState(raw.connectionState) ? { connectionState: decodeConnectionState(raw.connectionState)! } : {}),
  }
}

function decodeConnectionState(value: unknown): HarnessConnectionState | undefined {
  const raw = record(value)
  if (!raw || typeof raw.connectionId !== "string" || !raw.connectionId) return undefined
  const state = raw.state
  if (state !== "configured" && state !== "connecting" && state !== "ready" && state !== "auth-required" && state !== "disconnected" && state !== "failed") return undefined
  return { connectionId: raw.connectionId, state }
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
          modelId: model.modelID,
          ...(typeof model.providerID === "string" || model.providerID === null ? { providerId: model.providerID } : {}),
        }
      : null,
    variant: typeof raw.variant === "string" && raw.variant ? raw.variant : undefined,
  }
}

function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined }

