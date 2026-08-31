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

function runtimeHarnessType(input: Record<string, unknown> | undefined) {
  const id = string(input?.id)
  if (!id) return
  // Canonical runtime identity records are `{ id, access }` (`access` is
  // "acp" | "native"). `pickHarness` owns that translation — ACP records map
  // to their access-qualified `acp:<slug>` key, native records to the
  // built-in harness ids. Anything unrecognized yields undefined so the
  // caller's fallback chain can try the next config shape.
  return pickHarness(id, null, string(input?.access))
}
