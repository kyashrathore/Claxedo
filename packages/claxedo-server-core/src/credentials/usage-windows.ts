/**
 * The JSON round-trip for stored quota windows.
 *
 * Two tables hold the verifier's `CredentialUsageWindow[]` as text — one per
 * stored account, one per machine login — and both read it back through here,
 * so text that no longer parses reads as "no usage" in one place rather than
 * throwing out of whichever read reached it first.
 */

import { jsonNumber, jsonRecord, jsonString } from "@claxedo/server-core/platform/runtime/lib/json"
import type { CredentialUsageWindow } from "./types"

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
