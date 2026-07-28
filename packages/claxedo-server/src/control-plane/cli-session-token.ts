import { exportJWK, importPKCS8, importSPKI, jwtVerify, SignJWT, type JWTPayload } from "jose"
import { randomToken, sha256Hex16 } from "./web-crypto"
import type { SignedControlPlaneAuth, VerifiedClerkAuth } from "./auth"
import {
  resolveCliSessionTokenRegistry,
  type CliSessionTokenKind,
  type CliSessionTokenRegistry,
} from "./cli-session-registry"

const REFRESH_PREFIX = "claxedo_cli_refresh:"
const ACCESS_KIND = "claxedo_cli_access"
const REFRESH_KIND = "claxedo_cli_refresh"
const SESSION_ID_CLAIM = "claxedo_cli_session_id"
const SESSION_EXP_CLAIM = "claxedo_cli_session_exp"

type Env = Record<string, string | undefined>
type Algorithm = "EdDSA" | "ES256" | "RS256"

/**
 * Signer-enforced CLI access token TTL bounds (seconds).
 *
 * An access token is presented on every control-plane call, so it is the most
 * exposed of the two. One hour by default; twelve hours is the ceiling, which
 * covers a long working session without a refresh round-trip while keeping the
 * blast radius of a captured Authorization header inside a single day.
 */
export const CLI_ACCESS_TOKEN_TTL_BOUNDS_SECONDS = { min: 5 * 60, max: 12 * 60 * 60 } as const

/**
 * Signer-enforced CLI refresh token TTL bounds (seconds).
 *
 * The refresh token is the *idle* window: an actively used CLI rotates it on
 * every refresh and never sees the expiry, so this only bites an install that
 * has gone quiet. Fourteen days covers a normal holiday; thirty days is the
 * ceiling, so a credentials file copied off a laptop is inert within a month
 * even if nobody ever notices it was taken.
 */
export const CLI_REFRESH_TOKEN_TTL_BOUNDS_SECONDS = { min: 60 * 60, max: 30 * 24 * 60 * 60 } as const

/**
 * Absolute lifetime of one `claxedo login`, in seconds.
 *
 * Rotation resets the idle window but NOT this: ninety days after the original
 * login, every token descended from it stops verifying and the user
 * re-authenticates. Without an absolute cap, an endlessly-rotated chain is an
 * unbounded credential again — which is what the old ten-year accepted TTL
 * amounted to in practice.
 */
export const CLI_SESSION_MAX_LIFETIME_SECONDS = 90 * 24 * 60 * 60

export class CliSessionTokenError extends Error {
  constructor(
    public readonly code:
      | "cli_session_token_ttl_out_of_bounds"
      | "cli_session_token_claims_invalid"
      | "cli_session_token_kind_mismatch"
      | "cli_session_token_unknown"
      | "cli_session_token_revoked"
      | "cli_session_token_expired"
      | "cli_session_token_mismatch"
      | "cli_session_expired",
    message: string,
  ) {
    super(message)
  }
}

export type CliSessionTokenOptions = {
  /** Overrides the process-wide registry; primarily for tests and embedding. */
  registry?: CliSessionTokenRegistry
}

export type CliServiceUser = {
  token_identifier: string
  subject?: string
  issuer?: string
  email?: string
  name?: string
  image_url?: string
}

function clean(input?: string) {
  const value = input?.trim()
  return value ? value : undefined
}

function pem(input?: string) {
  return clean(input)?.replaceAll("\\n", "\n")
}

function algorithm(env: Env): Algorithm {
  const value = clean(env.CLAXEDO_CLI_TOKEN_ALGORITHM) ?? clean(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM)
  if (value === "ES256" || value === "RS256") return value
  return "EdDSA"
}

function issuer(env: Env) {
  return clean(env.CLAXEDO_CLI_TOKEN_ISSUER)
    ?? clean(env.CLAXEDO_CONTROL_PLANE_URL)
    ?? "https://claxedo-control-plane.local"
}

function audience(env: Env) {
  return clean(env.CLAXEDO_CLI_TOKEN_AUDIENCE) ?? "claxedo-control-plane"
}

/**
 * Resolve a configured TTL, REFUSING anything outside the signer's bounds.
 *
 * Deliberately not a clamp. Silently shrinking an out-of-range request leaves
 * the operator believing they got the lifetime they asked for; refusing at mint
 * time makes a misconfigured deployment fail loudly at the first login instead
 * of quietly issuing credentials with the wrong lifetime.
 */
function boundedTtlSeconds(
  name: string,
  raw: string | undefined,
  bounds: { readonly min: number; readonly max: number },
  fallback: number,
) {
  const configured = clean(raw)
  if (configured === undefined) return fallback
  const value = Number(configured)
  if (!Number.isFinite(value) || Math.floor(value) < bounds.min || Math.floor(value) > bounds.max) {
    throw new CliSessionTokenError(
      "cli_session_token_ttl_out_of_bounds",
      `${name} must be between ${bounds.min} and ${bounds.max} seconds`,
    )
  }
  return Math.floor(value)
}

function accessTtlSeconds(env: Env) {
  return boundedTtlSeconds(
    "CLAXEDO_CLI_ACCESS_TOKEN_TTL_SECONDS",
    env.CLAXEDO_CLI_ACCESS_TOKEN_TTL_SECONDS,
    CLI_ACCESS_TOKEN_TTL_BOUNDS_SECONDS,
    60 * 60,
  )
}

function refreshTtlSeconds(env: Env) {
  return boundedTtlSeconds(
    "CLAXEDO_CLI_REFRESH_TOKEN_TTL_SECONDS",
    env.CLAXEDO_CLI_REFRESH_TOKEN_TTL_SECONDS,
    CLI_REFRESH_TOKEN_TTL_BOUNDS_SECONDS,
    14 * 24 * 60 * 60,
  )
}

function privatePem(env: Env) {
  return pem(env.CLAXEDO_CLI_TOKEN_PRIVATE_KEY_PEM) ?? pem(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM)
}

function publicPem(env: Env) {
  return pem(env.CLAXEDO_CLI_TOKEN_PUBLIC_KEY_PEM) ?? pem(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM)
}

async function loadPrivateKey(env: Env) {
  const source = privatePem(env)
  if (!source) throw new Error("CLI token issuer is not configured")
  return importPKCS8(source, algorithm(env), { extractable: true })
}

async function loadPublicKey(env: Env) {
  const source = publicPem(env)
  if (!source) throw new Error("CLI token verifier is not configured")
  return importSPKI(source, algorithm(env))
}

async function deriveKid(privateKey: Parameters<typeof exportJWK>[0]) {
  const jwk = await exportJWK(privateKey)
  const material = String(jwk.x ?? jwk.n ?? "")
  if (!material) throw new Error("Unable to derive CLI token kid")
  return sha256Hex16(material)
}

function stringClaim(payload: JWTPayload, name: string) {
  const value = payload[name]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function numberClaim(payload: JWTPayload, name: string) {
  const value = payload[name]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** Map a wire token kind to the registry's coarse access/refresh split. */
function registryKind(kind: typeof ACCESS_KIND | typeof REFRESH_KIND): CliSessionTokenKind {
  return kind === ACCESS_KIND ? "access" : "refresh"
}

function serviceUser(payload: JWTPayload): CliServiceUser {
  const tokenIdentifier = stringClaim(payload, "token_identifier")
  if (!payload.sub || !tokenIdentifier) throw new Error("CLI token is missing user identity")
  return {
    token_identifier: tokenIdentifier,
    subject: payload.sub,
    ...(stringClaim(payload, "user_issuer") ? { issuer: stringClaim(payload, "user_issuer") } : {}),
    ...(stringClaim(payload, "email") ? { email: stringClaim(payload, "email") } : {}),
    ...(stringClaim(payload, "name") ? { name: stringClaim(payload, "name") } : {}),
    ...(stringClaim(payload, "image_url") ? { image_url: stringClaim(payload, "image_url") } : {}),
  }
}

function tokenIdentity(input: SignedControlPlaneAuth): CliServiceUser {
  return {
    token_identifier: input.user.tokenIdentifier,
    subject: input.user.subject,
    issuer: input.user.issuer,
  }
}

async function signToken(env: Env, input: {
  kind: typeof ACCESS_KIND | typeof REFRESH_KIND
  user: CliServiceUser
  /** Absolute expiry of this token, epoch seconds. */
  expiresAt: number
  /** Login-chain id and its absolute expiry (epoch seconds), carried as claims. */
  sessionId: string
  sessionExpiresAt: number
  audience: string
}) {
  const now = Math.floor(Date.now() / 1000)
  const key = await loadPrivateKey(env)
  const alg = algorithm(env)
  // The `jti` is generated here rather than by `.setJti()` so the caller can
  // record it in the revocation registry — a `jti` nobody can name is the same
  // as no `jti` at all.
  const jti = randomToken()
  const token = await new SignJWT({
    claxedo_token_kind: input.kind,
    token_identifier: input.user.token_identifier,
    user_issuer: input.user.issuer,
    email: input.user.email,
    name: input.user.name,
    image_url: input.user.image_url,
    [SESSION_ID_CLAIM]: input.sessionId,
    [SESSION_EXP_CLAIM]: input.sessionExpiresAt,
  })
    .setProtectedHeader({ alg, typ: "JWT", kid: clean(env.CLAXEDO_CLI_TOKEN_KID) ?? await deriveKid(key) })
    .setIssuer(issuer(env))
    .setAudience(input.audience)
    .setSubject(input.user.subject ?? input.user.token_identifier)
    .setIssuedAt(now)
    .setExpirationTime(input.expiresAt)
    .setJti(jti)
    .sign(key)
  return { token, jti }
}

export function isCliRefreshToken(input: string | undefined): input is string {
  return input?.startsWith(REFRESH_PREFIX) === true
}

export function isCliAccessAuth(input: SignedControlPlaneAuth) {
  return input.tokenKind === "cli"
}

export function cliServiceUser(input: SignedControlPlaneAuth): CliServiceUser {
  return {
    token_identifier: input.user.tokenIdentifier,
    subject: input.user.subject,
    issuer: input.user.issuer,
  }
}

/**
 * Sign one access/refresh pair and describe the registry rows it needs.
 *
 * Split out from `mintCliSessionTokens` so the SIGNING and the REGISTERING are
 * separable steps: rotation has to register its new pair in the same atomic
 * step that burns the old token, which it cannot do if minting insists on
 * writing the rows itself.
 */
async function signCliSessionPair(
  auth: SignedControlPlaneAuth,
  env: Env,
  options: { sessionId?: string; sessionExpiresAt?: number },
) {
  const user = tokenIdentity(auth)
  const accessTtl = accessTtlSeconds(env)
  const refreshTtl = refreshTtlSeconds(env)

  const nowSeconds = Math.floor(Date.now() / 1000)
  const sessionId = options.sessionId ?? randomToken()
  const sessionExpiresAtSeconds =
    options.sessionExpiresAt !== undefined
      ? Math.floor(options.sessionExpiresAt / 1000)
      : nowSeconds + CLI_SESSION_MAX_LIFETIME_SECONDS
  if (sessionExpiresAtSeconds <= nowSeconds) {
    throw new CliSessionTokenError("cli_session_expired", "CLI login has reached its maximum lifetime")
  }

  // Neither token may outlive the login chain it belongs to.
  const accessExpiresAt = Math.min(nowSeconds + accessTtl, sessionExpiresAtSeconds)
  const refreshExpiresAt = Math.min(nowSeconds + refreshTtl, sessionExpiresAtSeconds)

  const [access, refresh] = await Promise.all([
    signToken(env, {
      kind: ACCESS_KIND,
      user,
      expiresAt: accessExpiresAt,
      sessionId,
      sessionExpiresAt: sessionExpiresAtSeconds,
      audience: audience(env),
    }),
    signToken(env, {
      kind: REFRESH_KIND,
      user,
      expiresAt: refreshExpiresAt,
      sessionId,
      sessionExpiresAt: sessionExpiresAtSeconds,
      audience: `${audience(env)}:refresh`,
    }),
  ])

  const shared = {
    tokenIdentifier: user.token_identifier,
    subject: user.subject ?? user.token_identifier,
    sessionId,
    sessionExpiresAt: sessionExpiresAtSeconds * 1000,
  }

  return {
    records: [
      { ...shared, jti: access.jti, kind: "access" as const, expiresAt: accessExpiresAt * 1000 },
      { ...shared, jti: refresh.jti, kind: "refresh" as const, expiresAt: refreshExpiresAt * 1000 },
    ],
    response: {
      access_token: access.token,
      refresh_token: `${REFRESH_PREFIX}${refresh.token}`,
      token_type: "Bearer",
      expires_in: accessExpiresAt - nowSeconds,
      refresh_expires_in: refreshExpiresAt - nowSeconds,
      session_expires_in: sessionExpiresAtSeconds - nowSeconds,
      identity: auth.user.subject,
    },
  }
}

export async function mintCliSessionTokens(
  auth: SignedControlPlaneAuth,
  env: Env = process.env,
  options: CliSessionTokenOptions & {
    /** Continue an existing login chain (refresh rotation) instead of starting one. */
    sessionId?: string
    /** Absolute chain expiry, epoch ms. Rotation passes the original through. */
    sessionExpiresAt?: number
  } = {},
) {
  // Resolved FIRST: refusing to mint at all is better than handing out a
  // credential nothing can ever revoke.
  const registry = resolveCliSessionTokenRegistry(options.registry)
  const { records, response } = await signCliSessionPair(auth, env, options)

  // Recorded BEFORE the tokens leave this function. A mint that cannot be
  // registered is a mint that never happened: the caller gets the error and the
  // unregistered token would fail verification anyway.
  for (const record of records) await registry.recordMint(record)

  return response
}

/**
 * Signature check, then registry check. Both must pass.
 *
 * The registry lookup is what makes this revocable: a valid signature only
 * proves the token was minted here, never that it is still allowed. Every exit
 * from this function that is not an accept is a rejection — there is no path
 * where an unavailable or silent registry lets the token through.
 */
async function verifyCliToken(
  token: string,
  expectedKind: typeof ACCESS_KIND | typeof REFRESH_KIND,
  expectedAudience: string,
  env: Env,
  registry: CliSessionTokenRegistry,
) {
  const result = await jwtVerify(token, await loadPublicKey(env), {
    issuer: issuer(env),
    audience: expectedAudience,
  })
  const payload = result.payload
  if (payload.claxedo_token_kind !== expectedKind) {
    throw new CliSessionTokenError("cli_session_token_kind_mismatch", "CLI token kind mismatch")
  }

  const jti = stringClaim(payload, "jti")
  const tokenIdentifier = stringClaim(payload, "token_identifier")
  const sessionId = stringClaim(payload, SESSION_ID_CLAIM)
  const sessionExpiresAt = numberClaim(payload, SESSION_EXP_CLAIM)
  if (!jti || !tokenIdentifier || !sessionId || !sessionExpiresAt) {
    throw new CliSessionTokenError(
      "cli_session_token_claims_invalid",
      "CLI token is missing the claims required for revocation",
    )
  }

  // Absolute chain cap, enforced from the token itself so an expired login is
  // refused even if the registry row has already been reaped.
  if (sessionExpiresAt <= Math.floor(Date.now() / 1000)) {
    throw new CliSessionTokenError("cli_session_expired", "CLI login has reached its maximum lifetime")
  }

  const status = await registry.active({ jti, kind: registryKind(expectedKind), tokenIdentifier })
  if (!status.active) throw new CliSessionTokenError(status.code, status.reason)

  return { payload, jti, tokenIdentifier, sessionId, sessionExpiresAt }
}

/**
 * Exchange a refresh token for a fresh pair, ROTATING the chain.
 *
 * The presented refresh token is burned on success, so a captured copy is good
 * for at most one use and a replay of an already-spent token is rejected as
 * revoked. The chain id and its absolute expiry are carried through unchanged:
 * rotation renews the idle window, never the login itself.
 *
 * The burn and the registration are ONE `registry.rotate` step, not a mint
 * followed by a revoke. Done separately there is an interval where both the
 * spent token and its replacement verify, and a failure in that interval leaves
 * the "burned" token live for its full remaining TTL while its replacement is
 * already in the caller's hands. Here the new pair is signed first — signing
 * grants nothing, since an unregistered `jti` fails verification — and only
 * becomes usable if the same atomic step revoked the token it replaces. So a
 * rejected rotation leaves the chain exactly as it was, with the presented
 * token still the only live one.
 */
export async function refreshCliSessionTokens(
  refreshToken: string,
  env: Env = process.env,
  options: CliSessionTokenOptions = {},
) {
  const registry = resolveCliSessionTokenRegistry(options.registry)
  if (!isCliRefreshToken(refreshToken)) throw new Error("Not a Claxedo CLI refresh token")
  const verified = await verifyCliToken(
    refreshToken.slice(REFRESH_PREFIX.length),
    REFRESH_KIND,
    `${audience(env)}:refresh`,
    env,
    registry,
  )
  const payload = verified.payload
  const { records, response } = await signCliSessionPair(
    {
      mode: "signed",
      token: "",
      user: {
        subject: payload.sub ?? serviceUser(payload).token_identifier,
        tokenIdentifier: serviceUser(payload).token_identifier,
        issuer: stringClaim(payload, "user_issuer") ?? issuer(env),
      },
    },
    env,
    {
      sessionId: verified.sessionId,
      sessionExpiresAt: verified.sessionExpiresAt * 1000,
    },
  )
  const rotated = await registry.rotate({
    previous: { jti: verified.jti, tokenIdentifier: verified.tokenIdentifier },
    minted: records,
  })
  if (!rotated.ok) throw new CliSessionTokenError(rotated.code, rotated.reason)
  return response
}

export async function verifyCliAccessBearer(
  token: string,
  env: Env = process.env,
  options: CliSessionTokenOptions = {},
): Promise<VerifiedClerkAuth> {
  const registry = resolveCliSessionTokenRegistry(options.registry)
  const { payload } = await verifyCliToken(token, ACCESS_KIND, audience(env), env, registry)
  const user = serviceUser(payload)
  return {
    mode: "signed",
    tokenKind: "cli",
    user: {
      subject: user.subject ?? user.token_identifier,
      tokenIdentifier: user.token_identifier,
      issuer: user.issuer ?? issuer(env),
    },
  }
}

/**
 * Revoke one CLI session token by `jti`.
 *
 * Scoped to its owner so a caller cannot revoke another user's token by
 * guessing an id.
 */
export async function revokeCliSessionToken(
  args: { jti: string; tokenIdentifier: string },
  options: CliSessionTokenOptions = {},
) {
  return resolveCliSessionTokenRegistry(options.registry).revoke(args)
}

/** Revoke every token belonging to one `claxedo login` (that device's session). */
export async function revokeCliSessionChain(
  args: { sessionId: string; tokenIdentifier: string },
  options: CliSessionTokenOptions = {},
) {
  return resolveCliSessionTokenRegistry(options.registry).revokeSession(args)
}

/**
 * Revoke every CLI session token a user holds, on every device.
 *
 * The counterpart of `revokeForWorkspaceUser` on the Runtime Access Token path,
 * keyed on the user instead of a workspace because a CLI session token is not
 * workspace-scoped — it authenticates the human, everywhere.
 */
export async function revokeCliSessionTokensForUser(
  args: { tokenIdentifier: string },
  options: CliSessionTokenOptions = {},
) {
  return resolveCliSessionTokenRegistry(options.registry).revokeForUser(args)
}

/** Revoke-all keyed off a verified CLI auth context. */
export async function revokeCliSessionTokensForAuth(
  auth: SignedControlPlaneAuth,
  options: CliSessionTokenOptions = {},
) {
  return revokeCliSessionTokensForUser({ tokenIdentifier: auth.user.tokenIdentifier }, options)
}
