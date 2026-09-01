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
 * Both hosted compositions bound the relay provider to the SERVICE path only.
 * Every user-principal mint through the provider — the session pull, the
 * runtime transport — was therefore refused with "Only the configured
 * control-plane service actor may mint service runtime tokens", while the
 * workspace connection route minted the same user's token fine through the
 * other path. The control plane could not read a single session off a
 * user-hosted machine on its own behalf, so its registry stayed empty for
 * those workspaces and the web app listed nothing.
 *
 * One binding, chosen by `principalKind`, shared by both compositions so
 * they cannot drift apart again.
 */
export async function recordRelayRuntimeToken(
  authority: Pick<WorkspaceAuthority, "recordRuntimeAccessToken" | "recordRuntimeAccessTokenForService">,
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
  if (input.principalKind === "user") {
    if (!input.auth) {
      throw new Error("A user-principal runtime token must be minted for a signed caller")
    }
    return authority.recordRuntimeAccessToken(input.auth, scope)
  }
  return authority.recordRuntimeAccessTokenForService({ ...scope, principalKind: input.principalKind })
}
