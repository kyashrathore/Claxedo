import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "../../auth"
import { isCliAccessAuth } from "../../cli-session-token"
import { convexApi } from "./convex-authority-api"
import { requireAllowed, requireExecutor } from "./convex-authority-executor"
import type { ConvexAuthorityInput, ServiceArgs } from "./convex-authority-types"

export function workspaceAuthority(input: ConvexAuthorityInput, serviceArgs: ServiceArgs) {
  return {
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
        | { active: true; host_id: string; workspace_id: string; expires_at: number; last_seen_at: number }
        | { active: false }
      >
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
      projectId?: string
      displayName: string
      repoUrl?: string
      repoName?: string
      gitBranch?: string
      homeRegion?: string
    }) {
      return requireExecutor(input, auth).mutation(convexApi.workspaces.createCloud, {
        workspace_id: args.workspaceId,
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
      grantedToTokenIdentifier?: string
      grantedToClerkSubject?: string
      grantedToClerkOrgId?: string
    }) {
      return requireExecutor(input, auth).mutation(convexApi.workspaceShares.grant, {
        workspace_id: args.workspaceId,
        role: args.role,
        ...(args.grantedToTokenIdentifier ? { granted_to_token_identifier: args.grantedToTokenIdentifier } : {}),
        ...(args.grantedToClerkSubject ? { granted_to_clerk_subject: args.grantedToClerkSubject } : {}),
        ...(args.grantedToClerkOrgId ? { granted_to_clerk_org_id: args.grantedToClerkOrgId } : {}),
      })
    },
    async revokeWorkspaceShare(auth: SignedControlPlaneAuth, args: {
      workspaceId: string
      grantId?: string
      grantedToTokenIdentifier?: string
      grantedToClerkSubject?: string
      grantedToClerkOrgId?: string
    }) {
      return requireExecutor(input, auth).mutation(convexApi.workspaceShares.revoke, {
        workspace_id: args.workspaceId,
        ...(args.grantId ? { grant_id: args.grantId } : {}),
        ...(args.grantedToTokenIdentifier ? { granted_to_token_identifier: args.grantedToTokenIdentifier } : {}),
        ...(args.grantedToClerkSubject ? { granted_to_clerk_subject: args.grantedToClerkSubject } : {}),
        ...(args.grantedToClerkOrgId ? { granted_to_clerk_org_id: args.grantedToClerkOrgId } : {}),
      })
    },
  }
}
