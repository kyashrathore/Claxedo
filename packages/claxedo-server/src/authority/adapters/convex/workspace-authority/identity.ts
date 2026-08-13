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
      if (isCliAccessAuth(auth)) return requireExecutor(input, undefined, { allowUnsigned: true }).mutation(
        convexApi.users.meForService,
        serviceArgs(auth),
      )
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
    }): Promise<AuthorizeProjectResult> {
      const result = await requireExecutor(input, undefined, { allowUnsigned: true }).query(convexApi.channelIdentities.authorizeProject, {
        service_token: requireServiceToken(),
        channel: args.channel,
        external_user_id: args.externalUserId,
        thread_key: args.threadKey,
        project_id: args.projectId,
        action: args.action,
      }) as {
        actor_id?: string
        actor_kind?: "human" | "agent"
        actor_public_id?: string
        actor_name?: string
        actor_avatar_url?: string
      }
      const project = projectResult(result)
      if (!project.ok) return project
      return {
        ...project,
        ...(result.actor_id && result.actor_kind
          ? {
              actorId: result.actor_id,
              actorKind: result.actor_kind,
              ...(result.actor_public_id && result.actor_name
                ? {
                    actorPublicId: result.actor_public_id,
                    actorName: result.actor_name,
                    ...(result.actor_avatar_url ? { actorAvatarUrl: result.actor_avatar_url } : {}),
                  }
                : {}),
            }
          : {}),
      }
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
      }) as {
        allowed?: boolean
        actor_id?: string
        actor_kind?: "human" | "agent"
        actor_public_id?: string
        actor_name?: string
        actor_avatar_url?: string
      }
      await requireAllowed(result)
      if (result.actor_id && result.actor_kind) return {
        actorId: result.actor_id,
        actorKind: result.actor_kind,
        ...(result.actor_public_id && result.actor_name
          ? {
              actorPublicId: result.actor_public_id,
              actorName: result.actor_name,
              ...(result.actor_avatar_url ? { actorAvatarUrl: result.actor_avatar_url } : {}),
            }
          : {}),
      }
    },
  }
}
