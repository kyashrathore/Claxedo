import { jsonRecord } from "../runtime/lib/json"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "./auth"
import type { RuntimeActorIdentity, WorkspaceAuthority } from "./authority"
import { trimToUndefined } from "@claxedo/helpers/string"

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
  const row = jsonRecord(await authority.usersMe(auth))
  if (row) {
    const actorId = trimToUndefined(row.actor_id)
    const actorKind = row.actor_kind === "human" || row.actor_kind === "agent" ? row.actor_kind : undefined
    const actorPublicId = trimToUndefined(row.actor_public_id)
    const actorName = trimToUndefined(row.actor_name)
    if (actorId && actorKind) return {
      actorId,
      actorKind,
      ...(actorPublicId && actorName
        ? {
            actorPublicId,
            actorName,
            ...(trimToUndefined(row.actor_avatar_url) ? { actorAvatarUrl: trimToUndefined(row.actor_avatar_url) } : {}),
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

