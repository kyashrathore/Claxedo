/**
 * User-hosted signed traffic reaches the in-process embedded workspace runtime
 * through `embedded()` — not through `createRelayHostAuthMiddleware`. Without
 * this hop, `sessionAccessContext` never sees actor profile claims, so user
 * messages are stored without `claxedo.author` and MessageAuthorLane chips
 * never render.
 *
 * The control-plane stamps a **verified** actor onto a hop-only header via
 * `resolveRelayActor`. The embedded exposure middleware is the only consumer;
 * any client-supplied value is stripped before stamping. Unsigned Bearer JWT
 * payload decode is intentionally not used — that would skip verification and
 * allow author misattribution.
 */
import type { RuntimeActor } from "@claxedo/server-core/platform/auth/runtime-actor"

export const EMBEDDED_RELAY_HOST_AUTH_HEADER = "x-claxedo-embedded-relay-host-auth"

export type EmbeddedRelayHostAuth = {
  principal_kind: "user" | "service"
  actor_id: string
  actor_kind: "human" | "agent"
  actor_public_id: string
  actor_name: string
  actor_avatar_url?: string
  workspace_id: string
  org_id: string
  role: "viewer" | "editor" | "admin" | "owner"
  host_id?: string
  access?: "cloud" | "user-hosted"
  backing?: "cloud-vm" | "local-worktree"
}

type EmbeddedActor = RuntimeActor & {
  orgId: string
  role: "viewer" | "editor" | "admin" | "owner"
}

export function embeddedRelayHostAuthFromActor(
  actor: EmbeddedActor,
  workspaceId: string,
): EmbeddedRelayHostAuth {
  const actorPublicId = actor.actorPublicId?.trim()
  const actorName = actor.actorName?.trim()
  if (!actorPublicId || !actorName) {
    throw new TypeError("Embedded runtime actor display identity is unavailable")
  }
  return {
    principal_kind: actor.actorKind === "human" ? "user" : "service",
    actor_id: actor.actorId,
    actor_kind: actor.actorKind,
    actor_public_id: actorPublicId,
    actor_name: actorName,
    ...(actor.actorAvatarUrl ? { actor_avatar_url: actor.actorAvatarUrl } : {}),
    workspace_id: workspaceId,
    org_id: actor.orgId,
    role: actor.role,
  }
}

export function parseEmbeddedRelayHostAuthHeader(value: string | undefined): EmbeddedRelayHostAuth | undefined {
  if (!value?.trim()) return
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return
    const row = parsed as Record<string, unknown>
    const principal_kind = row.principal_kind === "user" || row.principal_kind === "service"
      ? row.principal_kind
      : undefined
    const actor_id = stringClaim(row, "actor_id")
    const actor_kind = row.actor_kind === "human" || row.actor_kind === "agent" ? row.actor_kind : undefined
    const actor_public_id = stringClaim(row, "actor_public_id")
    const actor_name = stringClaim(row, "actor_name")
    const workspace_id = stringClaim(row, "workspace_id")
    const org_id = stringClaim(row, "org_id")
    const role = roleClaim(row)
    if (
      !principal_kind
      || !actor_id
      || !actor_kind
      || (principal_kind === "user" && actor_kind !== "human")
      || (principal_kind === "service" && actor_kind !== "agent")
      || !actor_public_id
      || !actor_name
      || !workspace_id
      || !org_id
      || !role
    ) return
    return {
      principal_kind,
      actor_id,
      actor_kind,
      actor_public_id,
      actor_name,
      ...(stringClaim(row, "actor_avatar_url") ? { actor_avatar_url: stringClaim(row, "actor_avatar_url") } : {}),
      workspace_id,
      org_id,
      role,
      ...(stringClaim(row, "host_id") ? { host_id: stringClaim(row, "host_id") } : {}),
    }
  } catch {
    return
  }
}

function stringClaim(payload: Record<string, unknown>, key: string) {
  const value = payload[key]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function roleClaim(payload: Record<string, unknown>) {
  const value = stringClaim(payload, "role")
  return value === "viewer" || value === "editor" || value === "admin" || value === "owner" ? value : undefined
}
