import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "./auth"
import type { WorkspaceAuthority } from "./authority"

export type RuntimeActor = {
  actorId: string
  actorKind: "human" | "agent"
  actorPublicId: string
  actorName: string
  actorAvatarUrl?: string
}

export async function resolveRuntimeActor(authority: WorkspaceAuthority, auth: SignedControlPlaneAuth): Promise<RuntimeActor> {
  const identity = await authority.usersMe(auth)
  if (identity && typeof identity === "object" && !Array.isArray(identity)) {
    const row = identity as Record<string, unknown>
    const actorId = stringValue(row.actor_id) ?? stringValue(row.user_id)
    const actorKind = row.actor_kind === "human" || row.actor_kind === "agent"
      ? row.actor_kind
      : auth.tokenKind === "cli" ? "agent" : "human"
    const actorPublicId = stringValue(row.actor_public_id)
    const actorName = stringValue(row.actor_name)
    if (actorId && actorPublicId && actorName) return {
      actorId,
      actorKind,
      actorPublicId,
      actorName,
      ...(stringValue(row.actor_avatar_url) ? { actorAvatarUrl: stringValue(row.actor_avatar_url) } : {}),
    }
  }
  throw new ControlPlaneAuthError(
    503,
    "workspace_authority_unavailable",
    "Runtime actor identity is unavailable",
  )
}

function stringValue(input: unknown) {
  return typeof input === "string" && input.trim() ? input.trim() : undefined
}
