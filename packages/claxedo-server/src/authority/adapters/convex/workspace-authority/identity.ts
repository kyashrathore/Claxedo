import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { cliServiceUser, isCliAccessAuth } from "@claxedo/server-core/platform/auth/cli-session-token"
import { convexApi } from "./api"
import { projectResult, requireAllowed, requireExecutor, requireServiceToken } from "./executor"
import type {
  AuthorizeProjectArgs,
  AuthorizeProjectResult,
  ConvexAuthorityInput,
  OrgId,
  ProjectAction,
  ProjectRoleArgs,
  ProjectRoleResult,
  ServiceArgs,
} from "./types"

export function identityAuthority(input: ConvexAuthorityInput, serviceArgs: ServiceArgs) {
  return {
    async usersMe(auth: SignedControlPlaneAuth) {
      if (isCliAccessAuth(auth)) return { user_id: cliServiceUser(auth).token_identifier }
      return requireExecutor(input, auth).mutation(convexApi.users.me, {})
    },
    async listOrgs(auth: SignedControlPlaneAuth) {
      return requireExecutor(input, auth).query(convexApi.orgs.listForMe, {})
    },
    async resolveOrgId(auth: SignedControlPlaneAuth) {
      if (["1", "true", "yes"].includes((process.env.CLAXEDO_FORCE_MYORG ?? "").trim().toLowerCase()) && !auth.user.orgId) {
        throw new ControlPlaneAuthError(401, "invalid_bearer_token", "Signed auth token is missing an organization")
      }
      const result = await requireExecutor(input, auth).mutation(convexApi.orgs.resolveForMe, {
        ...(auth.user.orgId ? { clerk_org_id: auth.user.orgId } : {}),
      }) as { org_id?: string }
      if (!result.org_id) {
        throw new ControlPlaneAuthError(503, "workspace_authority_unavailable", "Convex did not resolve an organization")
      }
      return result.org_id as OrgId
    },
    async projectRole(auth: SignedControlPlaneAuth, args: ProjectRoleArgs): Promise<ProjectRoleResult> {
      return projectResult(await requireExecutor(input, auth).query(convexApi.projects.role, {
        project_id: args.projectId,
        ...(args.orgId ? { org_id: args.orgId } : {}),
      }))
    },
    async authorizeProject(auth: SignedControlPlaneAuth, args: AuthorizeProjectArgs): Promise<AuthorizeProjectResult> {
      return projectResult(await requireExecutor(input, auth).query(convexApi.projects.authorize, {
        project_id: args.projectId,
        action: args.action,
        ...(args.orgId ? { org_id: args.orgId } : {}),
      }))
    },
    async authorizeChannelProject(args: {
      channel: string
      externalUserId: string
      threadKey: string
      projectId: string
      action: ProjectAction
    }) {
      const result = await requireExecutor(input, undefined, { allowUnsigned: true }).query(convexApi.channelIdentities.authorizeProject, {
        service_token: requireServiceToken(),
        channel: args.channel,
        external_user_id: args.externalUserId,
        thread_key: args.threadKey,
        project_id: args.projectId,
        action: args.action,
      }) as { ok?: boolean; role?: string; org_id?: string; actor_id?: string; actor_kind?: "human" | "agent" }
      const authorized = projectResult(result)
      return authorized.ok && result.actor_id && result.actor_kind
        ? { ...authorized, actorId: result.actor_id, actorKind: result.actor_kind }
        : authorized
    },
    async authorizeChannelWorkspace(args: {
      channel: string
      externalUserId: string
      threadKey: string
      workspaceId: string
      action: ProjectAction
    }) {
      const result = await requireExecutor(input, undefined, { allowUnsigned: true }).query(convexApi.channelIdentities.authorizeWorkspace, {
        service_token: requireServiceToken(),
        channel: args.channel,
        external_user_id: args.externalUserId,
        thread_key: args.threadKey,
        workspace_id: args.workspaceId,
        action: args.action,
      }) as { allowed?: boolean; actor_id?: string; actor_kind?: "human" | "agent" }
      await requireAllowed(result)
      if (!result.actor_id || !result.actor_kind) throw new Error("Canonical channel actor is unavailable")
      return { actorId: result.actor_id, actorKind: result.actor_kind }
    },
    async bindChannelIdentity(auth: SignedControlPlaneAuth, args: { channel: string; externalUserId: string }) {
      const result = await requireExecutor(input, auth).mutation(convexApi.channelIdentities.bind, {
        channel: args.channel,
        external_user_id: args.externalUserId,
      }) as {
        binding_id: string
        created: boolean
        user_id: string
        actor_id: string
        actor_kind: "human" | "agent"
      }
      return {
        bindingId: result.binding_id,
        created: result.created,
        userId: result.user_id,
        actorId: result.actor_id,
        actorKind: result.actor_kind,
      }
    },
    async revokeChannelIdentity(auth: SignedControlPlaneAuth, args: { channel: string; externalUserId: string }) {
      return requireExecutor(input, auth).mutation(convexApi.channelIdentities.revoke, {
        channel: args.channel,
        external_user_id: args.externalUserId,
      }) as Promise<{ revoked: boolean }>
    },
  }
}
