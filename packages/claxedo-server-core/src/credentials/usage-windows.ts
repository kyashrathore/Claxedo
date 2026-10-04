/**
 * Quota windows: the vocabulary a vendor's answer is read into, and the JSON
 * round-trip the two tables that store them share.
 *
 * Four readers ask a vendor how much of a plan is left — the HTTP verifier, the
 * Codex app-server self-report, the machine-wide probe and Anthropic's OAuth
 * usage read — and each spells the same three windows differently. Naming,
 * clamping and reset parsing are here so a slot a vendor renames is renamed
 * once; `@claxedo/agent-runtime-contract` owns the names themselves, because
 * the event adapter and the app label the same windows from the same table.
 */

import { CODEX_WINDOW_NAME_BY_SECONDS, USAGE_WINDOW_NAMES } from "@claxedo/agent-runtime-contract"
import { jsonNumber, jsonRecord, jsonString } from "@claxedo/server-core/platform/runtime/lib/json"
import type { CredentialUsageWindow } from "./types"

/** A surface draws this as a bar, so a fraction or an out-of-range figure cannot reach one. */
export function clampPercent(value: number) {
  return Math.min(100, Math.max(0, Math.round(value)))
}

/** ChatGPT sends reset times as Unix seconds, Anthropic as ISO strings. */
export function usageResetMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/**
 * Claxedo's name for a slot, or the vendor's own where there is none. Inventing
 * a tier name for an unlisted slot would rot on the next vendor change without
 * anything failing.
 */
export function usageWindowName(harness: string, slot: string) {
  const slots = Object.hasOwn(USAGE_WINDOW_NAMES, harness) ? USAGE_WINDOW_NAMES[harness] : undefined
  return (slots && Object.hasOwn(slots, slot) ? slots[slot] : undefined) ?? slot
}

/**
 * Codex names a window by how long it runs rather than by the slot it arrives
 * in: a free plan gets only the weekly window, delivered in the primary slot.
 * The HTTP read gives `limit_window_seconds` and the app-server gives
 * `windowDurationMins`, so a caller converts to seconds before asking.
 */
export function codexWindowName(slot: string, seconds: number | undefined) {
  return (seconds !== undefined && Object.hasOwn(CODEX_WINDOW_NAME_BY_SECONDS, seconds) ? CODEX_WINDOW_NAME_BY_SECONDS[seconds] : undefined)
    ?? usageWindowName("codex", slot)
}

export function serializeUsageWindows(windows: readonly CredentialUsageWindow[]): string {
  return JSON.stringify(windows)
}

/**
 * Windows the stored text actually describes. A malformed entry is dropped
 * rather than carried as a partial window: a surface renders `usedPercent` as
 * a bar, and an absent one would draw an empty plan.
 */
export function parseUsageWindows(raw: string | null | undefined): CredentialUsageWindow[] | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const windows = parsed.flatMap((entry): CredentialUsageWindow[] => {
    const row = jsonRecord(entry)
    if (!row) return []
    const window = jsonString(row.window)
    const usedPercent = jsonNumber(row.usedPercent)
    if (window === undefined || usedPercent === undefined) return []
    return [{ window, usedPercent, resetsAt: jsonNumber(row.resetsAt) ?? null }]
  })
  return windows.length > 0 ? windows : null
}
