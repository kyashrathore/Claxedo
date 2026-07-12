import type { Placement } from "@/platform/runtime/placement"
import { can } from "@/platform/auth/role"
import { workspacePlacement } from "@/features/session/app-ports"

export function submitBlockedByRole(placement: Placement | undefined) {
  if (!placement) return false
  return !can("mutate.session", placement)
}

export function submitBlockedByWorkspaceRole(workspaceId: string | undefined) {
  return submitBlockedByRole(workspacePlacement(workspaceId))
}

export function promptDesignPlaceholder(input: { roleBlocked: boolean; mode: "normal" | "shell"; shellPlaceholder: string }) {
  if (input.roleBlocked) return "Read-only workspace (viewer)"
  if (input.mode === "shell") return input.shellPlaceholder
  return "Ask anything, / for commands, @ for context..."
}
