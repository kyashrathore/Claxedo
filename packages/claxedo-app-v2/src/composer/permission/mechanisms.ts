import type { NativeHarnessId } from "@/lib/harness-selection"

export type HarnessId = string
export type BuiltinHarnessId = NativeHarnessId
import { harnessDisplayLabel } from "@/lib/harness-catalog"

export type PermissionMechanism =
  | { kind: "claude-sdk-permission-mode" }
  | { kind: "acp-session-mode" }
  | { kind: "codex-approval-policy" }
  | { kind: "cursor-local-agent-options" }
  | { kind: "native-no-policy" }
  | { kind: "opencode-sdk-request-permissions" }

export const PERMISSION_MECHANISMS: Record<BuiltinHarnessId, PermissionMechanism> = {
  claude: { kind: "claude-sdk-permission-mode" },
  codex: { kind: "codex-approval-policy" },
  cursor: { kind: "cursor-local-agent-options" },
  pi: { kind: "native-no-policy" },
  opencode: { kind: "opencode-sdk-request-permissions" },
}

export const HARNESS_LABELS: Record<BuiltinHarnessId, string> = {
  claude: "Claude (SDK)",
  codex: "Codex (SDK)",
  cursor: "Cursor (SDK)",
  pi: "Pi",
  opencode: "OpenCode (SDK)",
}

export function permissionMechanism(harness: HarnessId): PermissionMechanism {
  const hit = (PERMISSION_MECHANISMS as Partial<Record<string, PermissionMechanism>>)[harness]
  if (hit) return hit
  return { kind: "acp-session-mode" }
}

export function harnessPermissionLabel(harness: HarnessId): string {
  return (HARNESS_LABELS as Partial<Record<string, string>>)[harness] ?? harnessDisplayLabel(harness)
}
