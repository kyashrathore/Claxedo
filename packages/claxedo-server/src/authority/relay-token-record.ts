import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { RelayToken, RelayTokenInput } from "@claxedo/server-core/adapters/relay-port"

/**
 * How a minted runtime access token is recorded, by WHO it was minted for.
 *
 * Two authority paths exist and they are not interchangeable:
 *   - `recordRuntimeAccessToken(auth, …)` records a USER's token under the
 *     caller's own principal and checks the token's actor is that caller.
 *   - `recordRuntimeAccessTokenForService(…)` records the control plane's own
 *     service token and refuses every other actor.
 *
 * Binding the relay provider to the SERVICE path alone refuses every
 * user-principal mint that reaches it — the session pull and the runtime
 * transport — and the control plane then reads no session off a machine on its
 * own behalf. `principalKind` chooses the path, in one binding both hosted
 * compositions share so they cannot drift apart.
 */
export async function recordRelayRuntimeToken(
  authority: Pick<WorkspaceAuthority, "recordRuntimeAccessToken" | "recordRuntimeAccessTokenForService" | "recordChannelRuntimeAccessToken" | "recordActorRuntimeAccessToken">,
  input: RelayTokenInput & RelayToken,
) {
  const scope = {
    jti: input.jti,
    workspaceId: input.workspaceId,
    hostId: input.hostId,
    actorId: input.actorId,
    actorKind: input.actorKind,
    role: input.role,
    expiresAt: input.expiresAt,
  }
  if ([!!input.auth, !!input.channelIdentity, !!input.delegatedActor].filter(Boolean).length > 1) throw new Error("Runtime token cannot have two caller identities")
  if (input.principalKind === "user") {
    if (input.delegatedActor) return authority.recordActorRuntimeAccessToken(scope)
    if (input.channelIdentity) {
      return authority.recordChannelRuntimeAccessToken(input.channelIdentity, scope)
    }
    if (!input.auth) {
      throw new Error("A user-principal runtime token must be minted for a signed caller")
    }
    return authority.recordRuntimeAccessToken(input.auth, scope)
  }
  return authority.recordRuntimeAccessTokenForService({ ...scope, principalKind: input.principalKind })
}
