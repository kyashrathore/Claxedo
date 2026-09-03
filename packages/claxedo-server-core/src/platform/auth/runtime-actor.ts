import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "./auth"
import type { RuntimeActorIdentity, WorkspaceAuthority } from "./authority"

export type RuntimeActor = RuntimeActorIdentity

export const CONTROL_PLANE_RUNTIME_ACTOR = {
  principalKind: "service",
  actorId: "control-plane",
  actorKind: "agent",
} as const

export async function resolveRuntimeActor(
  authority: Pick<WorkspaceAuthority, "usersMe">,
  auth: SignedControlPlaneAuth,
): Promise<RuntimeActor> {
  const identity = await authority.usersMe(auth)
  if (identity && typeof identity === "object" && !Array.isArray(identity)) {
    const row = identity as Record<string, unknown>
    const actorId = stringValue(row.actor_id)
    const actorKind = row.actor_kind === "human" || row.actor_kind === "agent" ? row.actor_kind : undefined
    const actorPublicId = stringValue(row.actor_public_id)
    const actorName = stringValue(row.actor_name)
    if (actorId && actorKind) return {
      actorId,
      actorKind,
      ...(actorPublicId && actorName
        ? {
            actorPublicId,
            actorName,
            ...(stringValue(row.actor_avatar_url) ? { actorAvatarUrl: stringValue(row.actor_avatar_url) } : {}),
          }
        : {}),
    }
  }
  throw new ControlPlaneAuthError(
    503,
    "workspace_authority_unavailable",
    "Canonical runtime actor identity is unavailable",
  )
}

function stringValue(input: unknown) {
  return typeof input === "string" && input.trim() ? input.trim() : undefined
}
