/**
 * Who may drive this daemon.
 *
 * Loopback is not the answer: every page a browser on this machine is showing
 * is also on loopback, and CORS decides only whether a page may READ a reply,
 * never whether it may make the call. Neither an `Origin` nor a peer address is
 * a credential, so the application holds one — the daemon token this process
 * was started with, under its own header because `Authorization` on these
 * routes already carries the relay's host token and, on a signed desktop, a
 * control-plane bearer.
 *
 * Electron main delivers it and the renderer never holds it; see the desktop's
 * `renderer-daemon-access.ts`.
 *
 * Callers admitted without it, each by something it can prove:
 *
 *   - THIS PROCESS, by object identity on the `Request` the composition built.
 *     A header would be sendable by anyone who can reach the port, and the
 *     in-process fetch dials `127.0.0.1` like every other loopback call.
 *   - HARNESS CHILDREN, at the mounts that verify a workspace-scoped runtime
 *     credential of their own. Minting them this machine-wide capability would
 *     replace a scoped authority with an unscoped one.
 *   - A RELAYED ORG MEMBER, only at the dispatcher that owns relayed traffic
 *     and only once the canonical ingress verifies the relay's signature. The
 *     `x-forwarded-by` marker alone proves nothing and reaches no other family.
 *   - A READINESS PROBE, on health GETs that carry no user data.
 */

import { timingSafeEqual } from "node:crypto"
import type { MiddlewareHandler } from "hono"
import { errorBody } from "@claxedo/server-core/platform/http/http"

export const DAEMON_CAPABILITY_HEADER = "x-claxedo-daemon-capability"

/**
 * Constant-time equality for a presented daemon secret.
 *
 * Both sides must be non-empty before the bytes are compared: `timingSafeEqual`
 * reports two zero-length buffers as equal, so a blank token would match every
 * caller that sends no header at all. Length is compared separately because
 * `timingSafeEqual` throws on a mismatch; the bytes are the secret, not the
 * length.
 */
export function daemonSecretMatches(presented: string | undefined, expected: string): boolean {
  if (!presented || !expected) return false
  const provided = Buffer.from(presented)
  const secret = Buffer.from(expected)
  return provided.length === secret.length && timingSafeEqual(provided, secret)
}

export function daemonBearer(header: string | undefined): string {
  return header?.replace(/^Bearer\s+/i, "") ?? ""
}

/**
 * The composition's declared capability, refused at boot if it is not one. A
 * blank identity is a launcher fault whose failure would otherwise be a listener
 * refusing every request with no statement of why.
 */
export function daemonCapability(token: string): string {
  if (token.trim().length === 0) {
    throw new Error(
      "the desktop-local composition requires a non-blank daemon identity token: it is the capability " +
        "the application is admitted by, and a blank one authenticates nobody",
    )
  }
  return token
}

/**
 * Paths that answer while machine ingress is closed.
 *
 * Recovery and inspection are exactly the surfaces whoever must decide what to
 * do about the fence needs. A session Stop submitted during a machine drain is
 * served through the session recovery route immediately: it is a narrower
 * authorization the caller already holds, not a request to widen the drain, so
 * it never waits for one.
 */
export function servedDuringMachineRecovery(method: string, pathname: string): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true
  if (pathname.startsWith("/api/claxedo/daemon")) return true
  return /\/session\/[^/]+\/recovery(\/operations\/[^/]+)?$/.test(pathname)
}

/**
 * Closes this machine to new work while a machine-scope operation is
 * outstanding. Mounted ahead of every route family, because the fence is a
 * property of the machine rather than of whichever handler admits a turn.
 */
export const DAEMON_RECOVERY_PATH = "/api/claxedo/daemon/recovery"

export function machineRecoveryFence(
  pending: () => MachineIngressRefusal | undefined,
): MiddlewareHandler {
  return async (c, next) => {
    const hold = pending()
    if (!hold || servedDuringMachineRecovery(c.req.method, new URL(c.req.raw.url).pathname)) return next()
    return c.json(
      errorBody("machine_recovery_pending", machineRecoveryMessage(hold), {
        // The machine's own reason is the broader one and settles first. This
        // is where a caller reads it, and where it finds a per-workspace reason
        // afterwards: that one is only meaningful once the machine has settled.
        inspect: { method: "GET", path: DAEMON_RECOVERY_PATH },
        ...(hold.kind === "operation" ? { operationId: hold.operationId } : {}),
      }),
      503,
    )
  }
}

export type MachineIngressRefusal =
  | { kind: "operation"; operationId: string }
  | { kind: "launch_reconciliation"; overdueAfterMs?: number }

function machineRecoveryMessage(hold: MachineIngressRefusal): string {
  if (hold.kind === "operation") {
    return `This machine is held by recovery operation ${hold.operationId}; new work is refused until it is resolved or released`
  }
  if (hold.overdueAfterMs !== undefined) {
    return `This machine's reconciliation of the launches its previous owner left unsettled has not answered in ${
      String(hold.overdueAfterMs)
    }ms; new work stays refused because nothing here has established what those launches are`
  }
  return "This machine is still reconciling the launches its previous owner left unsettled; new work is refused until that finishes"
}

/**
 * Requests this process built for itself. Object identity is the one property a
 * network peer cannot forge, and entries die with the request.
 */
const inProcessRequests = new WeakSet<Request>()

export function markInProcessDaemonRequest(request: Request): Request {
  inProcessRequests.add(request)
  return request
}

export function isInProcessDaemonRequest(request: Request): boolean {
  return inProcessRequests.has(request)
}

/**
 * What a delegated authority may answer: admit, refuse in its own words, or
 * "not my caller". Declared here rather than imported from the dispatcher so
 * this gate depends on no particular one; the composition that supplies both is
 * where the two shapes are checked against each other.
 */
export type DelegatedAdmission = { admit: true } | { refuse: Response }

export type DaemonAdmissionOptions = {
  /** Checked by {@link daemonCapability} at composition. */
  capability: string
  /** Readiness probes: no user data, answered before anyone holds a capability. */
  isPublicProbe: (method: string, pathname: string) => boolean
  /**
   * Paths a mount in THIS composition answers with a scoped credential check of
   * its own. Exactly those paths: an exemption wider than the mount leaves a
   * prefix ungated for whatever is registered under it next.
   */
  hasOwnCredentialAuthority: (pathname: string) => boolean
  /** The canonical relay dispatcher's verdict on a replayed request. */
  relayReplay: (request: Request) => Promise<DelegatedAdmission | undefined>
}

/**
 * Mounted once, ahead of every route family, so admission is a property of the
 * composition rather than a review item on each handler. Registered after the
 * deployment-posture guard, which answers the different question of whether
 * this deployment serves unsigned traffic at all.
 */
export function daemonAdmission(options: DaemonAdmissionOptions): MiddlewareHandler {
  const capability = daemonCapability(options.capability)
  return async (c, next) => {
    const request = c.req.raw
    if (isInProcessDaemonRequest(request)) return next()
    const pathname = new URL(request.url).pathname
    if (options.isPublicProbe(c.req.method, pathname)) return next()
    if (daemonSecretMatches(c.req.header(DAEMON_CAPABILITY_HEADER), capability)) return next()
    if (options.hasOwnCredentialAuthority(pathname)) return next()
    const relayed = await options.relayReplay(request)
    if (relayed && "admit" in relayed) return next()
    if (relayed) return relayed.refuse
    return c.json(
      errorBody(
        "daemon_capability_required",
        "This daemon route is reachable only by the application that owns this machine's daemon",
      ),
      401,
    )
  }
}
