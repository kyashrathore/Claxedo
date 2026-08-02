import {
  ControlPlaneAuthError,
  bearerToken,
  controlPlaneAuthConfig,
  controlPlaneAuthContext,
  type ClerkVerifier,
  type ControlPlaneAuthConfig,
  type SignedControlPlaneAuth,
} from "./auth"
import { internalAdminAuthorized } from "../http/routes/internal-admin-auth"
import { isLoopbackLocalRequest } from "../http/routes/peer-address"

/**
 * The five ways a request is allowed to reach a handler. Every route picks
 * exactly one.
 *
 * The problem this names away: the primitives below (`controlPlaneAuthContext`,
 * `bearerToken`, `isLoopbackLocalRequest`, `routeAuth`'s `requireSigned` flag)
 * compose into far more combinations than there are intended policies, and
 * nothing recorded which combination a route MEANT. A survey of 49 route files
 * found ~20 distinct combinations. A posture is the intent; the combination is
 * only how it is currently spelled.
 *
 * `Public` is in the list for the same reason `requireSigned` is not a default:
 * an unauthenticated route has to be typed out to exist, so it shows up in
 * review and in `routePostures()` rather than being the thing that happens when
 * a mount site forgets its options.
 */
export const RoutePosture = {
  /** Loopback only. The desktop/self-host surface; no bearer is consulted. */
  LocalOnly: "LOCAL_ONLY",
  /** A Clerk-verified user identity is required. */
  SignedUser: "SIGNED_USER",
  /** Machine-to-machine: a shared secret, never a user. */
  ServiceToken: "SERVICE_TOKEN",
  /** Operator surface behind the internal admin secret. */
  InternalAdmin: "INTERNAL_ADMIN",
  /** Deliberately unauthenticated. Must be named to be allowed. */
  Public: "PUBLIC",
} as const

export type RoutePosture = (typeof RoutePosture)[keyof typeof RoutePosture]

export type PostureOptions = {
  authConfig?: ControlPlaneAuthConfig
  verifier?: ClerkVerifier
  cliTokenEnv?: Record<string, string | undefined>
}

/**
 * What a posture check yields when it admits the request. `auth` is present
 * only for `SIGNED_USER`; the other postures authenticate a caller that has no
 * user identity, and handing back `undefined` keeps that difference in the
 * type rather than in a convention a handler can forget.
 */
export type PostureResult = {
  posture: RoutePosture
  auth?: SignedControlPlaneAuth
}

/**
 * The refusal an unconfigured operator surface answers with.
 *
 * Deliberately NOT a `ControlPlaneAuthError`: that type's status union is
 * `400 | 401 | 403 | 503`, and widening it to admit 404 would let any auth
 * refusal anywhere claim "not found". The narrow union is doing real work, so
 * this carries its own type instead.
 */
export class RouteNotFoundError extends Error {
  readonly status = 404 as const
  readonly code = "not_found" as const

  constructor() {
    super("not found")
    this.name = "RouteNotFoundError"
  }
}

/**
 * Loopback-only. Deliberately ignores the Authorization header: in this posture
 * no bearer can succeed, so consulting one could only produce a refusal that
 * misreports why (the pre-existing `missing_bearer_token`-for-a-request-that-
 * had-one bug in `control-plane-route-auth.ts`).
 */
export function localOnly(request: Request): PostureResult {
  if (!isLoopbackLocalRequest(request)) {
    throw new ControlPlaneAuthError(
      403,
      "hybrid_loopback_only",
      "this route is loopback-only and is not available through signed/team Control Plane access",
    )
  }
  return { posture: RoutePosture.LocalOnly }
}

/**
 * A verified signed user.
 *
 * The unsigned-local pass-through is not a hole: when signed auth is disabled
 * the deployment has no identity provider at all, and the global
 * `unsignedLocalRequestGuard` has already confined every such request to
 * loopback. Removing it here would break the desktop app, which runs with no
 * issuer configured.
 */
export async function signedUser(
  request: Request,
  options: PostureOptions = {},
): Promise<PostureResult> {
  const config = options.authConfig ?? controlPlaneAuthConfig()
  if (!config.enabled && config.mode === "local-only") {
    return { posture: RoutePosture.SignedUser }
  }
  const context = await controlPlaneAuthContext(request, {
    config,
    ...(options.verifier ? { verifier: options.verifier } : {}),
    ...(options.cliTokenEnv ? { cliTokenEnv: options.cliTokenEnv } : {}),
  })
  if (context.mode !== "signed") {
    throw new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required")
  }
  return { posture: RoutePosture.SignedUser, auth: context }
}

/**
 * A shared machine secret presented as a bearer token, compared in constant
 * time. Distinct from `signedUser` because there is no user to attribute the
 * call to, and distinct from `internalAdmin` because the secret is per-caller
 * rather than the operator's.
 */
export function serviceToken(request: Request, expected: string | undefined): PostureResult {
  const presented = bearerToken(request.headers.get("authorization"))
  if (!presented) {
    throw new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required")
  }
  if (!internalAdminAuthorized(request, expected)) {
    throw new ControlPlaneAuthError(401, "invalid_bearer_token", "Bearer token is invalid")
  }
  return { posture: RoutePosture.ServiceToken }
}

/**
 * The operator surface. Answers 404 rather than 401 when the secret is unset,
 * so an unconfigured admin surface is indistinguishable from one that does not
 * exist — a probe learns nothing about whether the deployment has one.
 */
export function internalAdmin(request: Request, expected: string | undefined): PostureResult {
  if (!expected?.trim()) {
    throw new RouteNotFoundError()
  }
  if (!internalAdminAuthorized(request, expected)) {
    throw new ControlPlaneAuthError(401, "invalid_bearer_token", "Bearer token is invalid")
  }
  return { posture: RoutePosture.InternalAdmin }
}

/**
 * Deliberately unauthenticated. Takes the reason as a required argument so the
 * justification lives at the call site, where a reviewer reading the route will
 * see it, rather than in a doc that drifts.
 */
export function publicRoute(reason: string): PostureResult {
  if (!reason.trim()) {
    throw new Error("publicRoute() requires a reason: an unauthenticated route must state why it is safe")
  }
  return { posture: RoutePosture.Public }
}
