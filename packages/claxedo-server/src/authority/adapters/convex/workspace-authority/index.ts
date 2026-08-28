import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { PrivateSessionAuthority } from "@claxedo/server-core/platform/auth/private-session-authority"
import { cliServiceUser } from "@claxedo/server-core/platform/auth/cli-session-token"
import { agentExtensionAuthority } from "./agent-extensions"
import { auditAuthority } from "./audit"
import { requireServiceToken } from "./executor"
import { hostEnrollmentAuthority } from "./host-enrollment"
import { identityAuthority } from "./identity"
import { runtimeTokenAuthority } from "./runtime-tokens"
import { sessionAuthority } from "./sessions"
import type { ConvexAuthorityInput } from "./types"
import { workspaceAuthority } from "./workspaces"

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
} from "./types"

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
  const serviceArgs = (auth?: SignedControlPlaneAuth) => ({
    service_token: requireServiceToken(input),
    ...(auth ? { user: cliServiceUser(auth) } : {}),
  })
  return {
    ...identityAuthority(input, serviceArgs),
    ...workspaceAuthority(input, serviceArgs),
    ...hostEnrollmentAuthority(input, serviceArgs),
    ...sessionAuthority(input),
    ...runtimeTokenAuthority(input),
    ...agentExtensionAuthority(input),
    ...auditAuthority(input),
  }
}

export type ConvexAuthority = WorkspaceAuthority & PrivateSessionAuthority
