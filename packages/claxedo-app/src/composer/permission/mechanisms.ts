import type { NativeHarnessId } from "@/lib/harness-selection"
import { harnessDisplayLabel } from "@/lib/harness-catalog"

export type HarnessId = string
export type BuiltinHarnessId = NativeHarnessId

export const HARNESS_LABELS: Record<BuiltinHarnessId, string> = {
  claude: "Claude (SDK)",
  codex: "Codex (SDK)",
  cursor: "Cursor (SDK)",
  pi: "Pi",
  opencode: "OpenCode (SDK)",
}

const NO_MODE_SURFACE: Partial<Record<BuiltinHarnessId, string>> = {
  pi: "Pi does not expose a permission mode. Its tools run with the permissions of the selected Local machine or Cloud sandbox.",
  opencode: "OpenCode has no permission modes of its own. It asks for each permission as a request in the session.",
}

export function noModeSurfaceReason(harness: HarnessId): string | undefined {
  return (NO_MODE_SURFACE as Partial<Record<string, string>>)[harness]
}

export function harnessPermissionLabel(harness: HarnessId): string {
  return (HARNESS_LABELS as Partial<Record<string, string>>)[harness] ?? harnessDisplayLabel(harness)
}
