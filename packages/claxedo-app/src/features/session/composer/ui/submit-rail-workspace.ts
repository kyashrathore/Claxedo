import { workspaceIdFromRef } from "@/platform/identity/legacy-resolver"
import { workspaceKey, type SessionRef } from "@/platform/identity/session-ref"

function publicWorkspaceId(value: string | undefined): string | undefined {
  return value && /^ws_/.test(value) ? value : undefined
}

/**
 * Workspace id stamped onto optimistic rail rows after create handoff.
 * Only public `ws_*` ids — never local association UUIDs that would duplicate
 * the row under both `local:` and `workspace:` sessionRefs.
 */
export function resolveCreatedSessionListWorkspaceId(input: {
  readonly sessionRef: SessionRef | undefined
  readonly workspaceId: string | undefined
  readonly sessionDirectory: string
}): string | undefined {
  // Prefer a concrete key from the session ref, but fall through when host is
  // "workspace" with no resolvable key (filesystem-backed localSessionRef on a
  // signed route) so the route-level `ws_*` input still wins.
  const fromRef =
    input.sessionRef?.host === "workspace" ? publicWorkspaceId(workspaceKey(input.sessionRef)) : undefined
  if (fromRef) return fromRef
  const fromRoute = publicWorkspaceId(input.workspaceId)
  if (fromRoute) return fromRoute
  return publicWorkspaceId(workspaceIdFromRef(input.sessionDirectory))
}
