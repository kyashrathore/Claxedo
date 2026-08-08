import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { HostEnrollment, HostEnrollmentState } from "@claxedo/server-core/platform/auth/authority"
import { isCliAccessAuth } from "@claxedo/server-core/platform/auth/cli-session-token"
import { convexApi } from "./api"
import { requireExecutor } from "./executor"
import type { ConvexAuthorityInput, ServiceArgs } from "./types"

/**
 * Machine-wide enrollment, against `convex/hostEnrollments.ts`.
 *
 * Its own module rather than more of `workspaces.ts` because nothing here is
 * workspace-scoped: a laptop is enrolled once, and which workspaces a session
 * may reach is decided at request time. The SQLite authority
 * (`claxedo-server-core/src/authority/adapters/sqlite/workspace-authority.ts`)
 * implements the same five methods over its own tables, and
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
    }): Promise<{ expires_at: number; last_seen_at: number }> {
      const body = {
        host_id: args.hostId,
        signature: args.signature,
        ...(args.ttlMs === undefined ? {} : { ttl_ms: args.ttlMs }),
      }
      const result = isCliAccessAuth(auth)
        ? await asService().mutation(convexApi.hostEnrollments.heartbeatForService, { ...serviceArgs(auth), ...body })
        : await requireExecutor(input, auth).mutation(convexApi.hostEnrollments.heartbeat, body)
      return result as { expires_at: number; last_seen_at: number }
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
  }
}
