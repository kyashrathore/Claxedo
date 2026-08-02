/**
 * Convex adapter for the CLI session token revocation registry.
 *
 * Every call here is a MACHINE call: the executor stays unsigned and the
 * verified principal is the control-plane service token, exactly like
 * `runtimeAccessTokens.active` / `.recordMintForService`. There is no end-user
 * JWT to pass through even in principle — the mint happens before any workspace
 * exists, and refresh rotation presents only a CLI refresh token, which Convex
 * cannot verify. Owner scoping is carried explicitly in `token_identifier`,
 * which the control plane always fills in from a VERIFIED auth context.
 */

import type { CliSessionTokenAuthority } from "../../cli-session-registry"
import { convexApi } from "./workspace-authority/api"
import { requireExecutor, requireServiceToken } from "./workspace-authority/executor"
import type { ConvexAuthorityInput } from "./workspace-authority/types"

export function cliSessionTokenAuthority(input: ConvexAuthorityInput): CliSessionTokenAuthority {
  const call = () => requireExecutor(input, undefined, { allowUnsigned: true })
  const service = () => ({ service_token: requireServiceToken(input) })
  return {
    async recordCliSessionToken(args) {
      return call().mutation(convexApi.cliSessionTokens.recordMint, { ...service(), ...args })
    },
    async rotateCliSessionTokens(args) {
      return call().mutation(convexApi.cliSessionTokens.rotate, { ...service(), ...args })
    },
    async cliSessionTokenActive(args) {
      return call().query(convexApi.cliSessionTokens.active, { ...service(), ...args })
    },
    async revokeCliSessionToken(args) {
      return call().mutation(convexApi.cliSessionTokens.revoke, { ...service(), ...args })
    },
    async revokeCliSessionChain(args) {
      return call().mutation(convexApi.cliSessionTokens.revokeSession, { ...service(), ...args })
    },
    async revokeCliSessionTokensForUser(args) {
      return call().mutation(convexApi.cliSessionTokens.revokeForUser, { ...service(), ...args })
    },
  }
}
