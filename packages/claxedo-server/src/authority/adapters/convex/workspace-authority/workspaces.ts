import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceShareTarget } from "@claxedo/server-core/platform/auth/authority"
import { isCliAccessAuth } from "@claxedo/server-core/platform/auth/cli-session-token"
import { convexApi } from "./api"
import { requireAllowed, requireExecutor } from "./executor"
import type { ConvexAuthorityInput, ServiceArgs } from "./types"

export function workspaceAuthority(input: ConvexAuthorityInput, serviceArgs: ServiceArgs) {
  return {
    async authorizeWorkspaceCreate(auth: SignedControlPlaneAuth, args: { orgId?: string }) {
      await requireAllowed(await requireExecutor(input, auth).query(convexApi.workspaces.authorizeCreate, {
        ...(args.orgId ? { org_id: args.orgId } : {}),
      }))
    },
    async authorizeWorkspaceOpen(auth: SignedControlPlaneAuth, args: {
      workspaceId: string
    }) {
      await requireAllowed(await requireExecutor(input, auth).query(convexApi.workspaces.open, {
        workspace_id: args.workspaceId,
      }))
    },
    async openWorkspace(auth: SignedControlPlaneAuth, args: {
      workspaceId: string
    }) {
      if (isCliAccessAuth(auth)) {
        const workspaces = await requireExecutor(input, undefined, { allowUnsigned: true }).query(
          convexApi.workspaces.listForService,
          serviceArgs(auth),
        ) as Array<{
          workspace_id?: string
          org_id?: string
          project_id?: string
          role?: string
          backing?: "local-worktree" | "cloud-vm"
          access?: "local" | "cloud" | "user-hosted"
          display_name?: string
          home_region?: string
        }>
        const workspace = workspaces.find((item) => item.workspace_id === args.workspaceId)
        if (!workspace?.role) throw new ControlPlaneAuthError(403, "workspace_authorization_denied", "Convex denied workspace access")
        return {
          allowed: true,
          role: workspace.role,
          workspace: {
            workspace_id: args.workspaceId,
            org_id: workspace.org_id,
            project_id: workspace.project_id,
            backing: workspace.backing,
            access: workspace.access,
            display_name: workspace.display_name,
            home_region: workspace.home_region,
          },
        }
      }
      const result = await requireExecutor(input, auth).query(convexApi.workspaces.open, {
        workspace_id: args.workspaceId,
      }) as {
        allowed?: boolean
        role?: string
        workspace?: {
          workspace_id: string
          org_id?: string
          project_id?: string
          backing: "local-worktree" | "cloud-vm"
          access: "local" | "cloud" | "user-hosted"
          display_name?: string
          home_region?: string
        }
      }
      await requireAllowed(result)
      return result
    },
    async listWorkspaces(auth: SignedControlPlaneAuth) {
      if (isCliAccessAuth(auth)) {
        return requireExecutor(input, undefined, { allowUnsigned: true }).query(
          convexApi.workspaces.listForService,
          serviceArgs(auth),
        )
      }
      return requireExecutor(input, auth).query(convexApi.workspaces.list, {})
    },
    async registerLocalForSharing(auth: SignedControlPlaneAuth, args: {
      workspaceId: string
      orgId?: string
      displayName: string
      projectId?: string
      repoUrl?: string
      repoName?: string
      gitBranch?: string
      remoteDirectory?: string
      homeRegion?: string
    }) {
      const body = {
        workspace_id: args.workspaceId,
        ...(args.orgId ? { org_id: args.orgId } : {}),
        display_name: args.displayName,
        ...(args.projectId ? { project_id: args.projectId } : {}),
        ...(args.repoUrl ? { repo_url: args.repoUrl } : {}),
        ...(args.repoName ? { repo_name: args.repoName } : {}),
        ...(args.gitBranch ? { git_branch: args.gitBranch } : {}),
        ...(args.remoteDirectory ? { remote_directory: args.remoteDirectory } : {}),
        ...(args.homeRegion ? { home_region: args.homeRegion } : {}),
      }
      if (isCliAccessAuth(auth)) {
        return requireExecutor(input, undefined, { allowUnsigned: true }).mutation(
          convexApi.workspaces.registerLocalForSharingForService,
          { ...serviceArgs(auth), ...body },
        )
      }
      return requireExecutor(input, auth).mutation(convexApi.workspaces.registerLocalForSharing, body)
    },
    async createLocalHostLinkChallenge(auth: SignedControlPlaneAuth, args: {
      workspaceId: string
      hostId: string
    }) {
      const body = {
        workspace_id: args.workspaceId,
        host_id: args.hostId,
      }
      if (isCliAccessAuth(auth)) {
        return requireExecutor(input, undefined, { allowUnsigned: true }).mutation(
          convexApi.localHostLinks.createChallengeForService,
          { ...serviceArgs(auth), ...body },
        ) as Promise<{ challenge_id: string; nonce: string; expires_at: number }>
      }
      return requireExecutor(input, auth).mutation(convexApi.localHostLinks.createChallenge, body) as Promise<{ challenge_id: string; nonce: string; expires_at: number }>
    },
    async registerLocalHostLink(auth: SignedControlPlaneAuth, args: {
      workspaceId: string
      hostId: string
      publicKey: string
      challengeId: string
      signature: string
      displayName?: string
      ttlMs?: number
    }) {
      const body = {
        workspace_id: args.workspaceId,
        host_id: args.hostId,
        public_key: args.publicKey,
        challenge_id: args.challengeId,
        signature: args.signature,
        ...(args.displayName ? { display_name: args.displayName } : {}),
        ...(args.ttlMs === undefined ? {} : { ttl_ms: args.ttlMs }),
      }
      if (isCliAccessAuth(auth)) {
        return requireExecutor(input, undefined, { allowUnsigned: true }).mutation(
          convexApi.localHostLinks.registerForService,
          { ...serviceArgs(auth), ...body },
        )
      }
      return requireExecutor(input, auth).mutation(convexApi.localHostLinks.register, body)
    },
    async heartbeatLocalHostLink(auth: SignedControlPlaneAuth, args: {
      workspaceId: string
      hostId: string
      signature: string
      ttlMs?: number
    }) {
      const body = {
        workspace_id: args.workspaceId,
        host_id: args.hostId,
        signature: args.signature,
        ...(args.ttlMs === undefined ? {} : { ttl_ms: args.ttlMs }),
      }
      if (isCliAccessAuth(auth)) {
        return requireExecutor(input, undefined, { allowUnsigned: true }).mutation(
          convexApi.localHostLinks.heartbeatForService,
          { ...serviceArgs(auth), ...body },
        )
      }
      return requireExecutor(input, auth).mutation(convexApi.localHostLinks.heartbeat, body)
    },
    async pauseLocalHostLink(auth: SignedControlPlaneAuth, args: {
      workspaceId: string
      hostId?: string
      paused: boolean
    }) {
      const body = {
        workspace_id: args.workspaceId,
        paused: args.paused,
        ...(args.hostId ? { host_id: args.hostId } : {}),
      }
      if (isCliAccessAuth(auth)) {
        return requireExecutor(input, undefined, { allowUnsigned: true }).mutation(
          convexApi.localHostLinks.pauseForService,
          { ...serviceArgs(auth), ...body },
        )
      }
      return requireExecutor(input, auth).mutation(convexApi.localHostLinks.pause, body)
    },
    async activeLocalHostLink(auth: SignedControlPlaneAuth, args: {
      workspaceId: string
    }) {
      return requireExecutor(input, auth).query(convexApi.localHostLinks.active, {
        workspace_id: args.workspaceId,
      }) as Promise<
        | { active: true; host_id: string; workspace_id: string; display_name?: string; second_device_open_at?: number; expires_at: number; last_seen_at: number }
        | { active: false }
      >
    },
    async markSecondDeviceOpen(auth: SignedControlPlaneAuth, args: { workspaceId: string }) {
      // Assignment grain: the "second device open" fact lives on the owner's
      // host_workspace_assignments row, not on the retired per-workspace link.
      return requireExecutor(input, auth).mutation(convexApi.hostEnrollments.markSecondDeviceOpen, {
        workspace_id: args.workspaceId,
      }) as Promise<{ recorded: boolean; second_device_open_at: number }>
    },
    async deleteWorkspace(auth: SignedControlPlaneAuth, args: {
      workspaceId: string
    }) {
      return requireExecutor(input, auth).mutation(convexApi.workspaces.delete, {
        workspace_id: args.workspaceId,
      })
    },
    async createCloudWorkspace(auth: SignedControlPlaneAuth, args: {
      workspaceId: string
      orgId?: string
      projectId?: string
      displayName: string
      repoUrl?: string
      repoName?: string
      gitBranch?: string
      homeRegion?: string
    }) {
      return requireExecutor(input, auth).mutation(convexApi.workspaces.createCloud, {
        workspace_id: args.workspaceId,
        ...(args.orgId ? { org_id: args.orgId } : {}),
        ...(args.projectId ? { project_id: args.projectId } : {}),
        display_name: args.displayName,
        ...(args.repoUrl ? { repo_url: args.repoUrl } : {}),
        ...(args.repoName ? { repo_name: args.repoName } : {}),
        ...(args.gitBranch ? { git_branch: args.gitBranch } : {}),
        ...(args.homeRegion ? { home_region: args.homeRegion } : {}),
      })
    },
    async grantWorkspaceShare(auth: SignedControlPlaneAuth, args: {
      workspaceId: string
      role: "viewer" | "editor" | "admin"
      target: WorkspaceShareTarget
    }) {
      return requireExecutor(input, auth).mutation(convexApi.workspaceShares.grant, {
        workspace_id: args.workspaceId,
        role: args.role,
        ...(args.target.kind === "actor" ? { target_actor_id: args.target.actorId } : {}),
        ...(args.target.kind === "user" ? { target_user_id: args.target.userId } : {}),
        ...(args.target.kind === "org" ? { target_org_id: args.target.orgId } : {}),
      })
    },
    async revokeWorkspaceShare(auth: SignedControlPlaneAuth, args: {
      workspaceId: string
      grantId?: string
      target?: WorkspaceShareTarget
    }) {
      return requireExecutor(input, auth).mutation(convexApi.workspaceShares.revoke, {
        workspace_id: args.workspaceId,
        ...(args.grantId ? { grant_id: args.grantId } : {}),
        ...(args.target?.kind === "actor" ? { target_actor_id: args.target.actorId } : {}),
        ...(args.target?.kind === "user" ? { target_user_id: args.target.userId } : {}),
        ...(args.target?.kind === "org" ? { target_org_id: args.target.orgId } : {}),
      })
    },
  }
}
