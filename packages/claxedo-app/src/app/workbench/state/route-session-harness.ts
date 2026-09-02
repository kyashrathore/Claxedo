import { pickHarness } from "../../../features/session/harness/profile"
import type { HarnessRef } from "@/platform/identity/session-ref"

export function routeSessionHarness(input: unknown): HarnessRef | undefined {
  const row = record(input)
  const harness = record(row?.harness)
  const runner = record(row?.runner)
  const config = record(row?.config)
  const configHarness = record(config?.harness)
  const configRunner = record(config?.runner)
  const connection = record(harness?.connection)
  const configConnection = record(configHarness?.connection)
  const taggedHarness = Array.isArray(row?.tags)
    ? row.tags.find((tag): tag is string => typeof tag === "string" && tag.startsWith("harness:"))?.slice("harness:".length)
    : undefined
  const id = pickHarness(
    string(row?.harnessType) ??
      runtimeHarnessType(harness) ??
      string(harness?.type) ??
      string(runner?.id) ??
      string(runner?.type) ??
      string(config?.harnessType) ??
      runtimeHarnessType(configHarness) ??
      string(configHarness?.type) ??
      string(configRunner?.id) ??
      string(configRunner?.type) ??
      string(taggedHarness),
    string(harness?.binary) ??
      string(connection?.binary) ??
      string(runner?.binary) ??
      string(configHarness?.binary) ??
      string(configConnection?.binary) ??
      string(configRunner?.binary),
  )
  if (!id || id === "opencode") return
  const binary = string(harness?.binary) ??
    string(connection?.binary) ??
    string(runner?.binary) ??
    string(configHarness?.binary) ??
    string(configConnection?.binary) ??
    string(configRunner?.binary)
  return {
    id,
    ...(binary ? { binary } : {}),
  }
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
