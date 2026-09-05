import { pickHarness } from "../../../features/session/harness/profile"
import { isHarnessSelection, type HarnessSelection } from "@/platform/identity/harness-selection"
import type { HarnessRef } from "@/platform/identity/session-ref"

export function routeSessionHarness(input: unknown): HarnessRef | undefined {
  const row = record(input)
  const value = row?.harness ?? record(row?.config)?.harness
  if (isHarnessSelection(value)) return value
  const harness = record(value)
  const selection = pickHarness(harness)
  if (!selection) return undefined
  const binary = string(harness?.binary)
  return { ...selection, ...(binary ? { binary } : {}) }
}

export function harnessReference(input: unknown): HarnessSelection | undefined {
  return isHarnessSelection(input) ? input : undefined
}

function record(input: unknown) {
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined
}

function string(input: unknown) {
  return typeof input === "string" && input.length > 0 ? input : undefined
}
