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

/**
 * Why the permission picker must not list this harness's modes.
 *
 * The draft mode list is a RECORDED table rather than something the agent said,
 * so it answers just as confidently for a harness that failed to start as for
 * one that is running. That produced a picker offering "Codex (ACP) · Agent" one
 * line under "Codex could not start" — worse than showing nothing, because the
 * rows read as the agent's own report and choosing one looks like setting a
 * policy that can never apply, there being no agent to apply it to.
 *
 * `harnessReadiness` already reaches a terminal "error"; the composer simply
 * never consumed it here, only "polling".
 */
export function harnessModesUnavailable(input: {
  isHarness: boolean
  readiness: string
  /**
   * A bad config counts as "cannot start" even while readiness still reads
   * ready or polling — which is exactly the case that slipped through first:
   * codex's config.toml was rejected, the composer's Send button already said
   * "The agent isn't running", and the picker went on listing modes because it
   * was only consulting readiness. `submitBlockReason` gates on both, so this
   * gates on both.
   */
  configError: boolean
  harness: string | undefined
}): string | undefined {
  if (!input.isHarness) return undefined
  if (input.readiness !== "error" && !input.configError) return undefined
  return `${input.harness ?? "This harness"} could not start, so its permission modes cannot be applied`
}
