import type { PermissionOption, PermissionOptionKind, ToolKind } from "@agentclientprotocol/sdk"

/** The decisions Claxedo can hand to an ACP agent. */
export type AcpPermissionDecision = "allow_once" | "allow_always" | "deny" | "reject_always"

/**
 * Which ACP option kinds satisfy a decision, best first.
 *
 * An agent may advertise only a subset of option kinds, so each decision has an
 * ordered set of acceptable representations.
 *
 * Substitutions are deliberately asymmetric:
 *
 *   - NARROWING a grant (`allow_always` → `allow_once`) is safe: the user gets
 *     less access than they asked for, and the call proceeds.
 *   - WIDENING a grant (`allow_once` → `allow_always`) is NEVER done. It would
 *     persist a permission the user granted for exactly one call.
 *   - WIDENING a denial (`reject_once` → `reject_always`) IS allowed: a broader
 *     "no" still fails safe, and beats cancelling and leaving the agent to retry.
 */
export function permissionOptionPreference(decision: AcpPermissionDecision): PermissionOptionKind[] {
  switch (decision) {
    case "allow_once":
      return ["allow_once"]
    case "allow_always":
      return ["allow_always", "allow_once"]
    case "deny":
      return ["reject_once", "reject_always"]
    case "reject_always":
      return ["reject_always", "reject_once"]
  }
}

/**
 * The option to answer with, or undefined when the agent advertised nothing
 * acceptable — in which case the caller must cancel rather than pick a kind that
 * contradicts the user's intent.
 */
export function selectPermissionOption(
  decision: AcpPermissionDecision,
  options: readonly PermissionOption[],
): PermissionOption | undefined {
  for (const kind of permissionOptionPreference(decision)) {
    const match = options.find((option) => option.kind === kind)
    if (match) return match
  }
  return undefined
}

/**
 * The compat `permission.asked` payload for an ACP permission request.
 *
 * `permission` is the protocol classification consumed by approval policy and
 * UI descriptions. Human-readable tool detail remains in `metadata.title`.
 */
export function acpPermissionRequest(input: {
  permId: string
  sessionId: string
  /** The agent's human-readable `toolCall.title`. */
  tool: string
  /** The protocol's `toolCall.kind`; absent when the agent sends none. */
  kind?: ToolKind
  paths: string[]
}) {
  return {
    id: input.permId,
    sessionID: input.sessionId,
    // `"other"` routes unclassified requests through the ask tier.
    permission: input.kind ?? ("other" satisfies ToolKind),
    patterns: input.paths,
    // Preserve the agent's human-readable description separately from policy.
    metadata: { title: input.tool },
    always: input.paths,
  }
}
