import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "./auth"
import type { RuntimeActorIdentity, WorkspaceAuthority } from "./authority"

export const CONTROL_PLANE_RUNTIME_ACTOR = {
  principalKind: "service",
  actorId: "control-plane",
  actorKind: "agent",
} as const

export async function resolveRuntimeActor(
  authority: Pick<WorkspaceAuthority, "usersMe">,
  auth: SignedControlPlaneAuth,
): Promise<RuntimeActorIdentity> {
  const identity = await authority.usersMe(auth)
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) return unavailable()
  const row = identity as Record<string, unknown>
  const actorId = text(row.actor_id)
  const actorKind = row.actor_kind
  if (!actorId || (actorKind !== "human" && actorKind !== "agent")) return unavailable()
  const actorPublicId = text(row.actor_public_id)
  const actorName = text(row.actor_name)
  const actorAvatarUrl = text(row.actor_avatar_url)
  return {
    actorId,
    actorKind,
    ...(actorPublicId && actorName
      ? { actorPublicId, actorName, ...(actorAvatarUrl ? { actorAvatarUrl } : {}) }
      : {}),
  }
}

function unavailable(): never {
  throw new ControlPlaneAuthError(
    503,
    "workspace_authority_unavailable",
    "Canonical runtime actor identity is unavailable",
  )
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}
