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
  // An operator-configured ACP connection: its access-qualified key is the
  // app-side identity (`pickHarness` recognizes it before binary sniffing).
  // The fixed `claude-acp`/`codex-acp`/`cursor-acp` scheme this used to
  // special-case here was retired in favor of the open `acp:<slug>` form —
  // every ACP-bound id, including the three former built-ins, now takes this
  // path.
  if (input?.access === "acp") return `acp:${id}`
  if (input?.access === "sdk" && (id === "claude" || id === "cursor")) return `${id}-sdk`
  return id
}
