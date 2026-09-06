import { asRecord } from "@claxedo/helpers/guards"
import { pickHarness } from "../../../features/session/harness/profile"
import { isHarnessSelection } from "@/platform/identity/harness-selection"
import type { HarnessRef } from "@/platform/identity/session-ref"

export function routeSessionHarness(input: unknown): HarnessRef | undefined {
  const row = asRecord(input)
  const value = row?.harness ?? asRecord(row?.config)?.harness
  if (isHarnessSelection(value)) return value
  const harness = asRecord(value)
  const selection = pickHarness(harness)
  if (!selection) return undefined
  const binary = string(harness?.binary)
  return { ...selection, ...(binary ? { binary } : {}) }
}

function string(input: unknown) {
  return typeof input === "string" && input.length > 0 ? input : undefined
}
