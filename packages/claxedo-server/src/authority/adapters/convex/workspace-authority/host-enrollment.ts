import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { HostEnrollment, HostEnrollmentState } from "@claxedo/server-core/platform/auth/authority"
import { isCliAccessAuth } from "@claxedo/server-core/platform/auth/cli-session-token"
import { convexApi } from "./api"
import { requireExecutor } from "./executor"
import type { ConvexAuthorityInput, ServiceArgs } from "./types"

/**
 * Machine-wide enrollment, against `convex/hostEnrollments.ts`.
 *
 * Its own module rather than more of `workspaces.ts` because everything here
 * is machine-domain: a laptop is enrolled once, and workspaces enter only at
 * the assignment grain (owner intent that host H serves workspace X, routed
 * with the heartbeat-acked consent set). The SQLite authority
 * (`claxedo-server-core/src/authority/adapters/sqlite/workspace-authority.ts`)
 * implements the same methods over its own tables, and
 * `routes/hosted/host-enrollment.parity.test.ts` runs the routes against BOTH
 * so a behaviour that exists on one backend only fails there.
 *
 * ## authed vs. `ForService`, per call
 *
 * Every method branches on `isCliAccessAuth(auth)`, the same branch
 * `workspaces.ts` makes for local host links, and it is an authorization
 * decision rather than a style one:
 *
 *  - A Clerk-issued bearer is a token CONVEX can verify. Passing it through
 *    (`requireExecutor(input, auth)`) lets `authedMutation` resolve the identity
 *    itself, so the end user's own credential — not this server's assertion
 *    about them — is what the row is written against. Reaching for the service
 *    variant here would discard that second verification and make a leaked
 *    service token enough to enroll a machine as anybody.
 *  - A CLI session token is minted and signed by this control plane, not by the
 *    identity provider, so `ctx.auth.getUserIdentity()` sees nothing and the
 *    authed functions reject it. That is the whole host-connector population,
 *    so those calls must go to the `ForService` variants, which carry the
 *    service token plus the identity this server already verified.
 *
 * `activeHostEnrollment` gets the same branch even though it is a read:
 * `activeForService` exists precisely so a CLI caller can ask about its own
 * machine, and answering `not-enrolled` to a connector that is enrolled would
 * send it to re-run the handshake forever.
 */
export function hostEnrollmentAuthority(input: ConvexAuthorityInput, serviceArgs: ServiceArgs) {
  /** The service executor carries no bearer; the service token in the args is the credential. */
  const asService = () => requireExecutor(input, undefined, { allowUnsigned: true })

  return {
    async createHostEnrollmentRequest(auth: SignedControlPlaneAuth, args: { hostId: string }) {
      const body = { host_id: args.hostId }
      const result = isCliAccessAuth(auth)
        ? await asService().mutation(convexApi.hostEnrollments.createRequestForService, {
          ...serviceArgs(auth),
          ...body,
        })
        : await requireExecutor(input, auth).mutation(convexApi.hostEnrollments.createRequest, body)
      return result as { request_id: string; nonce: string; expires_at: number }
    },

    async enrollHost(auth: SignedControlPlaneAuth, args: {
      hostId: string
      publicKey: string
      requestId: string
      signature: string
      displayName?: string
      ttlMs?: number
    }): Promise<HostEnrollment> {
      const body = {
        host_id: args.hostId,
        public_key: args.publicKey,
        request_id: args.requestId,
        signature: args.signature,
        ...(args.displayName ? { display_name: args.displayName } : {}),
        ...(args.ttlMs === undefined ? {} : { ttl_ms: args.ttlMs }),
      }
      const result = isCliAccessAuth(auth)
        ? await asService().mutation(convexApi.hostEnrollments.enrollForService, { ...serviceArgs(auth), ...body })
        : await requireExecutor(input, auth).mutation(convexApi.hostEnrollments.enroll, body)
      return result as HostEnrollment
    },

    async heartbeatHostEnrollment(auth: SignedControlPlaneAuth, args: {
      hostId: string
      signature: string
      ttlMs?: number
      workspaceIds: readonly string[]
    }): Promise<{ expires_at: number; last_seen_at: number; assigned_workspace_ids: string[] }> {
      const body = {
        host_id: args.hostId,
        signature: args.signature,
        ...(args.ttlMs === undefined ? {} : { ttl_ms: args.ttlMs }),
        // The v2 signature covers this served set; Convex verifies and stores
        // it as the machine's acked consent.
        workspace_ids: [...args.workspaceIds],
      }
      const result = isCliAccessAuth(auth)
        ? await asService().mutation(convexApi.hostEnrollments.heartbeatForService, { ...serviceArgs(auth), ...body })
        : await requireExecutor(input, auth).mutation(convexApi.hostEnrollments.heartbeat, body)
      return result as { expires_at: number; last_seen_at: number; assigned_workspace_ids: string[] }
    },

    async pauseHostEnrollment(auth: SignedControlPlaneAuth, args: {
      hostId?: string
      paused: boolean
    }): Promise<{ paused: boolean }> {
      const body = { paused: args.paused, ...(args.hostId ? { host_id: args.hostId } : {}) }
      const result = isCliAccessAuth(auth)
        ? await asService().mutation(convexApi.hostEnrollments.pauseForService, { ...serviceArgs(auth), ...body })
        : await requireExecutor(input, auth).mutation(convexApi.hostEnrollments.pause, body)
      // Narrowed to the port's shape ON PURPOSE. `pauseForUser` also returns how
      // many rows it touched, which the SQLite authority has no equivalent of —
      // and `POST /pause` returns this object verbatim, so passing `count`
      // through would make the HTTP response differ by backend. The port says
      // `{ paused }`; both adapters return exactly that.
      return { paused: (result as { paused: boolean }).paused }
    },

    async activeHostEnrollment(auth: SignedControlPlaneAuth): Promise<HostEnrollmentState> {
      const result = isCliAccessAuth(auth)
        ? await asService().query(convexApi.hostEnrollments.activeForService, serviceArgs(auth))
        : await requireExecutor(input, auth).query(convexApi.hostEnrollments.active, {})
      return result as HostEnrollmentState
    },

    // --- owner assignments (assignment grain of the same domain) ------------
    async assignWorkspaceHost(auth: SignedControlPlaneAuth, args: {
      workspaceId: string
      hostId: string
      displayName?: string
      orgId?: string
      projectId?: string
      repoUrl?: string
      repoName?: string
      gitBranch?: string
      remoteDirectory?: string
      homeRegion?: string
    }): Promise<{ assigned: true; workspace_id: string; host_id: string }> {
      const body = {
        workspace_id: args.workspaceId,
        host_id: args.hostId,
        ...(args.displayName ? { display_name: args.displayName } : {}),
        ...(args.orgId ? { org_id: args.orgId } : {}),
        ...(args.projectId ? { project_id: args.projectId } : {}),
        ...(args.repoUrl ? { repo_url: args.repoUrl } : {}),
        ...(args.repoName ? { repo_name: args.repoName } : {}),
        ...(args.gitBranch ? { git_branch: args.gitBranch } : {}),
        ...(args.remoteDirectory ? { remote_directory: args.remoteDirectory } : {}),
        ...(args.homeRegion ? { home_region: args.homeRegion } : {}),
      }
      const result = isCliAccessAuth(auth)
        ? await asService().mutation(convexApi.hostEnrollments.assignWorkspaceForService, { ...serviceArgs(auth), ...body })
        : await requireExecutor(input, auth).mutation(convexApi.hostEnrollments.assignWorkspace, body)
      return result as { assigned: true; workspace_id: string; host_id: string }
    },

    async unassignWorkspaceHost(auth: SignedControlPlaneAuth, args: {
      workspaceId: string
    }): Promise<{ unassigned: boolean }> {
      const body = { workspace_id: args.workspaceId }
      const result = isCliAccessAuth(auth)
        ? await asService().mutation(convexApi.hostEnrollments.unassignWorkspaceForService, { ...serviceArgs(auth), ...body })
        : await requireExecutor(input, auth).mutation(convexApi.hostEnrollments.unassignWorkspace, body)
      return result as { unassigned: boolean }
    },

    async activeWorkspaceHost(auth: SignedControlPlaneAuth, args: { workspaceId: string }) {
      return await requireExecutor(input, auth).query(convexApi.hostEnrollments.activeWorkspaceHost, {
        workspace_id: args.workspaceId,
      }) as
        | { active: true; host_id: string; workspace_id: string; display_name?: string; second_device_open_at?: number; expires_at: number; last_seen_at: number }
        | { active: false }
    },

    async listHostAssignments(auth: SignedControlPlaneAuth) {
      return await requireExecutor(input, auth).query(convexApi.hostEnrollments.listAssignments, {}) as Array<{
        host_id: string
        display_name: string
        last_seen_at: number
        expires_at: number
        workspace_ids: string[]
        acked_workspace_ids: string[]
      }>
    },
  }
}
