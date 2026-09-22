import type { ContentfulStatusCode } from "hono/utils/http-status"
import {
  ControlPlaneAuthError,
  controlPlaneAuthErrorBody,
  type SignedControlPlaneAuth,
} from "@claxedo/server-core/platform/auth/auth"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { ControlPlaneServices } from "../authority/services"
import {
  createFixedWindowConnectionRateLimiter,
  type ConnectionRateLimiter,
} from "../platform/auth/rate-limit"
import type { CloudWorkspaceEntitlementGate } from "./route-support"
import {
  controlPlaneRateLimitDenial,
  sandboxLeaseCapDenial,
  type ActiveSandboxLeaseCounter,
  type SandboxLeaseTenant,
} from "./runtime-token-guards"

/**
 * `POST /create` requests per minute, per caller.
 *
 * Sized against what the operation COSTS, not against what the transport can
 * take. Every accepted create clones a repo into a freshly provisioned sandbox
 * VM — seconds to minutes of cold start, billed. Nothing legitimate approaches
 * this: the app creates one workspace per explicit user action, and even an
 * impatient human retrying a failed create stays in low single digits per
 * minute. Five leaves room for retries and double-submits while cutting the
 * worst case a single isolate can provision from the 120/min control-plane
 * class to 5/min — a 24x reduction in the cost of a create flood.
 */
const DEFAULT_CREATE_LIMIT = 5
const DEFAULT_CREATE_WINDOW_MS = 60_000

/**
 * Concurrently-live sandbox leases per tenant.
 *
 * This is a blast-radius bound, not a business quota — the billing entitlement
 * gate is what expresses "what did you pay for". At roughly one live sandbox
 * per actively-working seat plus headroom for background/agent workspaces, 25
 * comfortably covers a ~10-seat team without ever being reached in normal use,
 * while capping what a compromised token or a runaway client can leave running
 * at 25 VMs instead of "as many as it can ask for". Deployments that need a
 * different number set `sandboxLeaseCap`.
 *
 * The same number bounds a personal account, where the tenant is the single
 * signing subject rather than an org — generous for one human, and still a
 * bound, which is what a stolen personal token had none of before.
 */
const DEFAULT_SANDBOX_LEASE_CAP = 25

const unavailableActiveLeaseCounter: ActiveSandboxLeaseCounter = async () => undefined

/**
 * Who a cloud create is admitted as. A signed request answers for itself; a
 * create initiated by a minted credential — a session's agent starting a
 * cloud-placed task — is admitted as the owner the credential resolved to.
 * The two are the same policy on different evidence: every gate that reads a
 * bearer reads the owner's resolved identity instead on the second door.
 */
export type CloudCreateCaller =
  | { kind: "signed"; auth: SignedControlPlaneAuth }
  | { kind: "owner"; owner: { userId: string; orgId: string } }

export type CloudCreateAdmissionDenial = {
  status: ContentfulStatusCode
  body: { error: { code: string; message: string; [field: string]: unknown } }
}

/**
 * The product-owned usage side effects a cloud create runs on the lease it
 * opens — `leaseOpened` before provisioning starts so `startedAt` covers the
 * cold start, `recordLeaseTenant` once the lease row exists so the
 * concurrency cap has something to count. The tenant is the caller this
 * admission already verified; it is never an input a caller supplies.
 */
export type CloudCreateUsage = {
  leaseOpened(input: {
    caller: CloudCreateCaller
    workspaceId: string
    driver: string
    startedAt: number
    services?: ControlPlaneServices
  }): void
  recordLeaseTenant(input: {
    caller: CloudCreateCaller
    workspaceId: string
  }): Promise<void>
}

/**
 * The caller's tenant, in the id space the cap counts on — the columns
 * `recordLeaseTenant` stamps onto the lease row. A signed caller's is the
 * issuer org claim and token subject (deliberately NOT the authority's
 * internally-resolved org id: keying the count on one id space while the rows
 * carry another produces a count of zero forever). A credential-initiated
 * create has no claims to read, so its tenant is the resolved owner's
 * authority identity — the organization the workspace lands in and the user
 * it is created as.
 */
function callerTenant(caller: CloudCreateCaller): SandboxLeaseTenant {
  return caller.kind === "signed"
    ? { orgId: caller.auth.user.orgId, ownerSubject: caller.auth.user.subject }
    : { orgId: caller.owner.orgId, ownerSubject: caller.owner.userId }
}

function callerSubject(caller: CloudCreateCaller): string {
  return caller.kind === "signed" ? caller.auth.user.subject : caller.owner.userId
}

function callerAudit(caller: CloudCreateCaller): SignedControlPlaneAuth | undefined {
  return caller.kind === "signed" ? caller.auth : undefined
}

export type CloudCreateAdmission = {
  /**
   * The cheap half: the per-caller create budget, asked before a request body
   * is read or an authority round-trip starts.
   */
  preflight(caller: CloudCreateCaller): Promise<CloudCreateAdmissionDenial | undefined>
  /**
   * The authority half of create admission, in the order `POST
   * /api/workspace/create` applies it: the authority's own create admission,
   * then the paid-capability entitlement, then the concurrent-lease cap.
   *
   * `selectors` are the caller's tenant selectors, normalized here: blank
   * strings are absent, so a caller cannot name `""` to reach a different
   * resolution than a missing field.
   */
  admit(
    caller: CloudCreateCaller,
    selectors: { orgId?: string; projectId?: string },
    options?: { existing?: boolean },
  ): Promise<CloudCreateAdmissionDenial | undefined>
}

/**
 * The deployment's half of create admission: everything beyond the authority's
 * own check. A policy that names none of it still rate-limits and caps by the
 * defaults; the entitlement and lease counter are the seams a deployment
 * supplies when it owns billing and a durable lease store.
 */
export type CloudCreateAdmissionPolicy = {
  /** The per-caller create budget. A supplied limiter is shared with the create route when the same instance is handed to both. */
  rateLimiter?: ConnectionRateLimiter
  /** The paid-capability gate. Absent hook = no billing gate (self-host). */
  entitlement?: CloudWorkspaceEntitlementGate
  /** `0` disables the concurrent-lease cap; absent means the default. */
  leaseCap?: number
  /** The cap's authority read (tests, alternative authorities). */
  countActiveLeases?: ActiveSandboxLeaseCounter
}

/**
 * The one create admission, built once per composition so its rate limiter
 * outlives a request. Both create doors — the route and the Tasks cloud-root
 * allocation — are handed the same object, so a policy change cannot reach
 * one and not the other.
 *
 * `authorizeWorkspaceCreate` runs for signed callers only, and fails closed
 * when the authority cannot answer it — the route's rule, kept. The owner
 * door's equivalent runs inside `createRuntimeCloudWorkspace` itself, whose
 * admission is the same organization-admin check creation applies.
 */
export function createCloudCreateAdmission(
  input: { services: ControlPlaneServices | undefined } & CloudCreateAdmissionPolicy,
): CloudCreateAdmission {
  const rateLimiter =
    input.rateLimiter ??
    createFixedWindowConnectionRateLimiter({
      limit: DEFAULT_CREATE_LIMIT,
      windowMs: DEFAULT_CREATE_WINDOW_MS,
    })
  const countActiveLeases = input.countActiveLeases ?? unavailableActiveLeaseCounter
  const leaseCap = input.leaseCap ?? DEFAULT_SANDBOX_LEASE_CAP
  return {
    preflight: (caller) =>
      controlPlaneRateLimitDenial(input.services, rateLimiter, {
        subject: callerSubject(caller),
        ...(callerAudit(caller) ? { audit: callerAudit(caller) } : {}),
      }, {
        key: "workspaces.create",
        action: "workspace.create.denied",
      }),

    admit: async (caller, selectors, options) => {
      if (caller.kind === "signed") {
        try {
          const authority = requireAuthority(input.services)
          if (!authority.authorizeWorkspaceCreate) {
            throw new ControlPlaneAuthError(
              503,
              "workspace_authority_unavailable",
              "Workspace creation authorization is unavailable",
            )
          }
          await authority.authorizeWorkspaceCreate(caller.auth, {
            ...(selectors.orgId?.trim() ? { orgId: selectors.orgId.trim() } : {}),
            ...(selectors.projectId?.trim() ? { projectId: selectors.projectId.trim() } : {}),
          })
        } catch (err) {
          if (err instanceof ControlPlaneAuthError) {
            return { status: err.status, body: controlPlaneAuthErrorBody(err) }
          }
          throw err
        }
      }
      if (input.entitlement) {
        const denied = await input.entitlement(
          caller.kind === "signed" ? { auth: caller.auth } : { orgId: caller.owner.orgId },
        )
        if (denied) return { status: denied.status, body: denied.body }
      }
      // The cap bounds NEW allocations. `existing` is the idempotent retry the
      // allocator reports when an earlier attempt filed the row: its lease is
      // already counted, so counting it again would refuse the retry for the
      // very spend it is resuming — the same reason the route's wake path does
      // not re-cap an existing workspace.
      if (options?.existing) return undefined
      return await sandboxLeaseCapDenial(input.services, {
        tenant: callerTenant(caller),
        ...(callerAudit(caller) ? { audit: callerAudit(caller) } : {}),
        cap: leaseCap,
        action: "workspace.create.denied",
        countActiveLeases,
      })
    },
  }
}
