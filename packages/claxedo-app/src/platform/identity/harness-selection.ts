export const NATIVE_HARNESS_IDS = ["claude", "codex", "cursor", "pi", "opencode"] as const

/**
 * Native harnesses whose models come from the control plane's provider catalog
 * (`/api/claxedo/agent-config/providers?nativeHarness=<id>`) rather than from
 * harness config options: Pi and the embedded OpenCode SDK both run against
 * Claxedo-held provider credentials.
 */
export const CATALOG_HARNESS_IDS = ["pi", "opencode"] as const

export function isCatalogHarnessId(id: string | undefined): id is (typeof CATALOG_HARNESS_IDS)[number] {
  return (CATALOG_HARNESS_IDS as readonly string[]).includes(id ?? "")
}

export type NativeHarnessId = (typeof NATIVE_HARNESS_IDS)[number]

export type HarnessSelection =
  | { readonly kind: "native"; readonly harnessId: NativeHarnessId }
  | { readonly kind: "connection"; readonly connectionId: string }

export function nativeHarness(harnessId: NativeHarnessId): HarnessSelection {
  return { kind: "native", harnessId }
}

export function connectionHarness(connectionId: string): HarnessSelection {
  return { kind: "connection", connectionId }
}

export function isHarnessSelection(input: unknown): input is HarnessSelection {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false
  const row = input as Record<string, unknown>
  if (
    row.kind === "native"
    && typeof row.harnessId === "string"
    && (NATIVE_HARNESS_IDS as readonly string[]).includes(row.harnessId)
  ) return Object.keys(row).every((key) => key === "kind" || key === "harnessId")
  if (row.kind === "connection" && typeof row.connectionId === "string" && row.connectionId.trim()) {
    return Object.keys(row).every((key) => key === "kind" || key === "connectionId")
  }
  return false
}

export function sameHarnessSelection(left: HarnessSelection | undefined, right: HarnessSelection | undefined) {
  if (left === right) return true
  if (!left || !right || left.kind !== right.kind) return false
  return left.kind === "native"
    ? right.kind === "native" && left.harnessId === right.harnessId
    : right.kind === "connection" && left.connectionId === right.connectionId
}

/** Stable cache identity only. Persisted and wire contracts keep the discriminated object. */
export function harnessSelectionKey(input: HarnessSelection) {
  return input.kind === "native"
    ? JSON.stringify({ kind: input.kind, harnessId: input.harnessId })
    : JSON.stringify({ kind: input.kind, connectionId: input.connectionId })
}

export function harnessSelectionValue(input: HarnessSelection) {
  return input.kind === "native" ? input.harnessId : input.connectionId
}

export function harnessSelectionQuery(input: HarnessSelection):
  | { nativeHarness: NativeHarnessId }
  | { connectionId: string } {
  return input.kind === "native"
    ? { nativeHarness: input.harnessId }
    : { connectionId: input.connectionId }
}
