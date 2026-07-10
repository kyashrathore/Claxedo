import type { Placement } from "../shell/auth/placement"
import { can } from "../shell/auth/role"

export function terminalBlockedByRole(placement: Placement | undefined) {
  // Local and unresolved placements remain governed by their server boundary.
  if (!placement) return false
  return !can("use.terminal", placement)
}
