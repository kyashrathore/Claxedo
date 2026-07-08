import type { SignedControlPlaneAuth } from "../../auth"
import type { WorkspaceAuthority } from "../../authority"
import { cliServiceUser } from "../../cli-session-token"
import { agentExtensionAuthority } from "./convex-authority-agent-extensions"
import { auditAuthority } from "./convex-authority-audit"
import { requireServiceToken } from "./convex-authority-executor"
import { identityAuthority } from "./convex-authority-identity"
import { runtimeTokenAuthority } from "./convex-authority-runtime-tokens"
import { sessionAuthority } from "./convex-authority-sessions"
import type { ConvexAuthorityInput } from "./convex-authority-types"
import { workspaceAuthority } from "./convex-authority-workspaces"

export type {
  AuthorizeProjectArgs,
  AuthorizeProjectResult,
  OrgId,
  ProjectAction,
  ProjectId,
  ProjectRole,
  ProjectRoleArgs,
  ProjectRoleResult,
  WorkspaceId,
} from "./convex-authority-types"

/**
 * Resolve the workspace-authority backend URL from deployment env.
 *
 * The neutral env name (`CLAXEDO_WORKSPACE_AUTHORITY_URL`) is the only accepted
 * name. The env knowledge lives HERE, in the Convex adapter — composition roots
 * construct through this helper and the generic control-plane core never names
 * the storage backend.
 */
export function convexAuthorityUrlFromEnv(env: Record<string, string | undefined>): string | undefined {
  const url = env.CLAXEDO_WORKSPACE_AUTHORITY_URL?.trim()
  return url ? url : undefined
}

export function createConvexAuthority(input: ConvexAuthorityInput = {}): WorkspaceAuthority {
  const serviceArgs = (auth: SignedControlPlaneAuth) => ({
    service_token: requireServiceToken(input),
    user: cliServiceUser(auth),
  })
  return {
    ...identityAuthority(input, serviceArgs),
    ...workspaceAuthority(input, serviceArgs),
    ...sessionAuthority(input, serviceArgs),
    ...runtimeTokenAuthority(input),
    ...agentExtensionAuthority(input),
    ...auditAuthority(input),
  }
}

export type ConvexAuthority = WorkspaceAuthority
