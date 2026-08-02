import type { SignedControlPlaneAuth } from "../../../auth"

// The neutral authority contract is owned by the control-plane port; the Convex
// adapter re-exports the shared identity types so its return shape stays
// structurally compatible with `WorkspaceAuthority`.
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
} from "../../../authority"

export type ConvexExecutor = {
  query: (fn: unknown, args: Record<string, unknown>) => Promise<unknown>
  mutation: (fn: unknown, args: Record<string, unknown>) => Promise<unknown>
}

export type ConvexAuthorityInput = {
  url?: string
  executor?: ConvexExecutor
  serviceToken?: string
}

export type ServiceArgs = (auth: SignedControlPlaneAuth) => Record<string, unknown>
