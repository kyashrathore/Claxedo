import type { PermissionOption, PermissionOptionKind, ToolKind } from "@agentclientprotocol/sdk"

/** The decisions Claxedo can hand to an ACP agent. */
export type AcpPermissionDecision = "allow_once" | "allow_always" | "deny" | "reject_always"

/**
 * Which ACP option kinds satisfy a decision, best first.
 *
 * An agent only has to advertise the option kinds it supports, so the exact kind
 * we want may be absent.
 * Matching one kind and giving up meant answering `cancelled`, which kills the
 * tool call: choosing "always allow" against such an agent cancelled the call
 * instead of allowing it.
 *
 * The fallbacks are deliberately ASYMMETRIC:
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
 * `permission` must be a CLASSIFICATION, because that is what every consumer keys
 * on: the app's auto-approve allowlist matches it, and the permission dock looks
 * up `settings.permissions.tool.<permission>.description` with it. This carried
 * `toolCall.title` — free-form prose like "Read file src/index.ts" — so the
 * allowlist matched nothing (auto-approve was inert on every ACP harness) and the
 * dock's i18n lookup always missed, discarding the title too.
 *
 * Extracted from the inline literal it used to be so the mapping is testable: the
 * old version was wrong while every test passed.
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
    // `"other"` is a real `ToolKind` member and sits in the ask tier, so an
    // unclassified request fails SAFE rather than inheriting whatever a prose
    // title happened to spell.
    permission: input.kind ?? ("other" satisfies ToolKind),
    patterns: input.paths,
    // The only human-readable description of what the agent wants to do. Keep it.
    metadata: { title: input.tool },
    always: input.paths,
  }
}
