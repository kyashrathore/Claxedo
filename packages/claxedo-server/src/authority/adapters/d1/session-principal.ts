import type { D1Database } from "@cloudflare/workers-types"
import type { PrivateSessionActor, PrivateSessionRuntimePrincipal } from "@claxedo/server-core/platform/auth/private-session-authority"
import type { AuthorizationPrincipal } from "./authorization"
import { D1SessionAuthorityError, requireText } from "./session-input"

export type D1SessionPrincipal = PrivateSessionActor & AuthorizationPrincipal & { userId: string }

type ActorRow = {
  actor_id: string
  actor_kind: "human" | "agent"
  actor_state: "active" | "suspended" | "revoked"
  user_id: string | null
  user_state: "active" | "suspended" | "deleted" | null
}

/** Resolve the active canonical actor carried by a host-verified runtime credential. */
export async function requireD1RuntimeSessionActor(database: D1Database, input: PrivateSessionRuntimePrincipal): Promise<D1SessionPrincipal> {
  const actorId = requireText(input.actorId, "actorId")
  if ((input.principalKind !== "user" && input.principalKind !== "service")
    || (input.actorKind !== "human" && input.actorKind !== "agent")
    || (input.principalKind === "user" && input.actorKind !== "human")
    || (input.principalKind === "service" && input.actorKind !== "agent")) {
    throw new D1SessionAuthorityError("invalid_input", "Canonical runtime principal kind is required")
  }
  const row = await database.prepare(`
    SELECT a.actor_id, a.kind AS actor_kind, a.state AS actor_state, a.user_id, u.state AS user_state
    FROM actors a LEFT JOIN users u ON u.user_id = a.user_id WHERE a.actor_id = ?
  `).bind(actorId).first<ActorRow>()
  if (!row || row.actor_kind !== input.actorKind || row.actor_state !== "active" || !row.user_id || row.user_state !== "active") {
    throw new D1SessionAuthorityError("actor_authorization_denied", "Canonical active session actor is required")
  }
  return { actorId, actorKind: row.actor_kind, userId: row.user_id }
}
