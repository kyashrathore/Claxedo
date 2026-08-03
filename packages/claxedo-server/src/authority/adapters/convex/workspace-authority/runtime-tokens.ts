import type { SignedControlPlaneAuth } from "../../../../platform/auth/auth"
import { convexApi } from "./api"
import { requireExecutor, requireServiceToken } from "./executor"
import type { ConvexAuthorityInput } from "./types"

export function runtimeTokenAuthority(input: ConvexAuthorityInput) {
  return {
    async recordRuntimeAccessToken(auth: SignedControlPlaneAuth, args: {
      jti: string
      workspaceId: string
      hostId: string
      expiresAt: number
    }) {
      return requireExecutor(input, auth).mutation(convexApi.runtimeAccessTokens.recordMint, {
        jti: args.jti,
        workspace_id: args.workspaceId,
        host_id: args.hostId,
        expires_at: args.expiresAt,
      })
    },
    async recordRuntimeAccessTokenForService(args: {
      jti: string
      workspaceId: string
      hostId: string
      subject: string
      expiresAt: number
    }) {
      return requireExecutor(input, undefined, { allowUnsigned: true }).mutation(
        convexApi.runtimeAccessTokens.recordMintForService,
        {
          service_token: requireServiceToken(input),
          jti: args.jti,
          workspace_id: args.workspaceId,
          host_id: args.hostId,
          subject: args.subject,
          expires_at: args.expiresAt,
        },
      )
    },
    async runtimeAccessTokenActive(args: {
      jti: string
      workspaceId: string
      hostId: string
    }) {
      // Machine path with no end-user JWT: the executor stays unsigned, and the
      // verified principal is the control-plane service token. Convex
      // rejects the call without it.
      return requireExecutor(input, undefined, { allowUnsigned: true }).query(convexApi.runtimeAccessTokens.active, {
        service_token: requireServiceToken(input),
        jti: args.jti,
        workspace_id: args.workspaceId,
        host_id: args.hostId,
      })
    },
    async revokeRuntimeAccessToken(auth: SignedControlPlaneAuth, args: {
      jti: string
      workspaceId: string
    }) {
      return requireExecutor(input, auth).mutation(convexApi.runtimeAccessTokens.revoke, {
        jti: args.jti,
        workspace_id: args.workspaceId,
      })
    },
    async revokeRuntimeAccessTokensForWorkspaceUser(auth: SignedControlPlaneAuth, args: {
      workspaceId: string
    }) {
      return requireExecutor(input, auth).mutation(convexApi.runtimeAccessTokens.revokeForWorkspaceUser, {
        workspace_id: args.workspaceId,
      })
    },
  }
}
