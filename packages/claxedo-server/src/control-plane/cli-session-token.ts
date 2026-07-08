import { exportJWK, importPKCS8, importSPKI, jwtVerify, SignJWT, type JWTPayload } from "jose"
import { randomToken, sha256Hex16 } from "./web-crypto"
import type { SignedControlPlaneAuth, VerifiedClerkAuth } from "./auth"

const REFRESH_PREFIX = "claxedo_cli_refresh:"
const ACCESS_KIND = "claxedo_cli_access"
const REFRESH_KIND = "claxedo_cli_refresh"

type Env = Record<string, string | undefined>
type Algorithm = "EdDSA" | "ES256" | "RS256"

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

function accessTtlSeconds(env: Env) {
  const value = Number(clean(env.CLAXEDO_CLI_ACCESS_TOKEN_TTL_SECONDS))
  return Number.isFinite(value) && value >= 300 && value <= 24 * 60 * 60 ? Math.floor(value) : 60 * 60
}

function refreshTtlSeconds(env: Env) {
  const value = Number(clean(env.CLAXEDO_CLI_REFRESH_TOKEN_TTL_SECONDS))
  return Number.isFinite(value) && value >= 60 * 60 && value <= 10 * 365 * 24 * 60 * 60
    ? Math.floor(value)
    : 90 * 24 * 60 * 60
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
  ttlSeconds: number
  audience: string
}) {
  const now = Math.floor(Date.now() / 1000)
  const key = await loadPrivateKey(env)
  const alg = algorithm(env)
  return new SignJWT({
    claxedo_token_kind: input.kind,
    token_identifier: input.user.token_identifier,
    user_issuer: input.user.issuer,
    email: input.user.email,
    name: input.user.name,
    image_url: input.user.image_url,
  })
    .setProtectedHeader({ alg, typ: "JWT", kid: clean(env.CLAXEDO_CLI_TOKEN_KID) ?? await deriveKid(key) })
    .setIssuer(issuer(env))
    .setAudience(input.audience)
    .setSubject(input.user.subject ?? input.user.token_identifier)
    .setIssuedAt(now)
    .setExpirationTime(now + input.ttlSeconds)
    .setJti(randomToken())
    .sign(key)
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

export async function mintCliSessionTokens(auth: SignedControlPlaneAuth, env: Env = process.env) {
  const user = tokenIdentity(auth)
  const accessTtl = accessTtlSeconds(env)
  const refreshTtl = refreshTtlSeconds(env)
  const [accessToken, refreshToken] = await Promise.all([
    signToken(env, {
      kind: ACCESS_KIND,
      user,
      ttlSeconds: accessTtl,
      audience: audience(env),
    }),
    signToken(env, {
      kind: REFRESH_KIND,
      user,
      ttlSeconds: refreshTtl,
      audience: `${audience(env)}:refresh`,
    }),
  ])
  return {
    access_token: accessToken,
    refresh_token: `${REFRESH_PREFIX}${refreshToken}`,
    token_type: "Bearer",
    expires_in: accessTtl,
    refresh_expires_in: refreshTtl,
    identity: auth.user.subject,
  }
}

async function verifyCliToken(token: string, expectedKind: typeof ACCESS_KIND | typeof REFRESH_KIND, expectedAudience: string, env: Env) {
  const result = await jwtVerify(token, await loadPublicKey(env), {
    issuer: issuer(env),
    audience: expectedAudience,
  })
  if (result.payload.claxedo_token_kind !== expectedKind) throw new Error("CLI token kind mismatch")
  return result.payload
}

export async function refreshCliSessionTokens(refreshToken: string, env: Env = process.env) {
  if (!isCliRefreshToken(refreshToken)) throw new Error("Not a Claxedo CLI refresh token")
  const payload = await verifyCliToken(
    refreshToken.slice(REFRESH_PREFIX.length),
    REFRESH_KIND,
    `${audience(env)}:refresh`,
    env,
  )
  return mintCliSessionTokens({
    mode: "signed",
    token: "",
    user: {
      subject: payload.sub ?? serviceUser(payload).token_identifier,
      tokenIdentifier: serviceUser(payload).token_identifier,
      issuer: stringClaim(payload, "user_issuer") ?? issuer(env),
    },
  }, env)
}

export async function verifyCliAccessBearer(token: string, env: Env = process.env): Promise<VerifiedClerkAuth> {
  const payload = await verifyCliToken(token, ACCESS_KIND, audience(env), env)
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
