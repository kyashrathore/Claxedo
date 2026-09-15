import { jwtVerify, SignJWT, type JWTPayload } from "jose"
import { runtimeAccessTokenIssuer } from "@claxedo/workspace-relay"
import { randomToken } from "@claxedo/server-core/platform/auth/web-crypto"
import { RUNTIME_ACCESS_TOKEN_ALGORITHM, resolveMintKid } from "@claxedo/server-core/platform/auth/runtime-access-token"
import {
  requiredCredentialField,
  runtimeTokenSigningKey,
  runtimeTokenVerificationKey,
  type CredentialFault,
} from "./runtime-token-keys"
import type { SandboxPassRegister } from "./sandbox-pass-register"

/**
 * The one shape of every pass a sandbox holds that this control plane can
 * verify: the Tasks capability, the Agent Plugins gateway token, and every
 * grant plan 004 adds after them.
 *
 * All of them are signed with the runtime access-token key under its
 * published `kid` (a JWKS verifier holding the current and the next key can
 * pick one only by it), name the control plane as issuer, carry their own
 * audience so none can be replayed as another, name one user (the subject),
 * one organization and one workspace, list the operations they permit, and
 * carry a `jti` so one pass can be revoked without ending the rest. What differs between passes — the
 * audience, the operation vocabulary, and any claims beyond the scope — is
 * the audience's own rule, applied over the result of {@link verifySandboxPass}.
 *
 * The runtime's own HS256 session credential and the egress broker's
 * placeholder token are not passes: neither is minted by the control plane,
 * and neither is ever presented to it.
 */
export type SandboxPassScope = Readonly<{
  userId: string
  orgId: string
  workspaceId: string
  projectId?: string
  sessionId?: string
}>

export type SandboxPassInput = Readonly<{
  audience: string
  scope: SandboxPassScope
  operations: readonly string[]
  /** Claims beyond the scope, under the audience's own names; none may reuse a family claim name. */
  extra?: Readonly<Record<string, string>>
  ttlSeconds?: number
  now?: () => number
  /** Where the minted `jti` is written down, so the pass can be taken back before it expires. */
  register?: SandboxPassRegister
}>

export type SandboxPass = Readonly<{
  audience: string
  scope: SandboxPassScope
  /** Empty only for a token carrying no `operations` claim; whether that is acceptable is the audience's rule. */
  operations: readonly string[]
  extra: Readonly<Record<string, unknown>>
  jti: string
  issuedAt: number
  expiresAt: number
}>

export const SANDBOX_PASS_DEFAULT_TTL_SECONDS = 30 * 60
export const SANDBOX_PASS_MAX_TTL_SECONDS = 60 * 60
const MIN_TTL_SECONDS = 60

/** The token is well signed for this audience but does not say what a pass must say. */
export class SandboxPassError extends Error {
  readonly code = "sandbox_pass_invalid"
  constructor(readonly audience: string, detail: string) {
    super(`Sandbox pass for ${audience} ${detail}`)
  }
}

const SCOPE_CLAIMS = {
  userId: "user_id",
  orgId: "org_id",
  workspaceId: "workspace_id",
  projectId: "project_id",
  sessionId: "session_id",
} as const

const FAMILY_CLAIMS = new Set<string>([...Object.values(SCOPE_CLAIMS), "operations", "iss", "aud", "sub", "jti", "iat", "exp", "nbf"])

function lifetimeSeconds(requested: number | undefined, fault: CredentialFault) {
  if (requested === undefined) return SANDBOX_PASS_DEFAULT_TTL_SECONDS
  if (!Number.isFinite(requested)) throw fault("a finite ttlSeconds")
  return Math.min(SANDBOX_PASS_MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Math.floor(requested)))
}

export async function mintSandboxPass(input: SandboxPassInput, env: Record<string, string | undefined>, fault: CredentialFault) {
  const { scope, extra = {} } = input
  requiredCredentialField(input.audience, "audience", fault)
  for (const name of ["userId", "orgId", "workspaceId"] as const) requiredCredentialField(scope[name], name, fault)
  for (const name of ["projectId", "sessionId"] as const) {
    if (scope[name] !== undefined) requiredCredentialField(scope[name], name, fault)
  }
  if (input.operations.length === 0) throw fault("at least one operation")
  for (const operation of input.operations) requiredCredentialField(operation, "operation", fault)
  for (const [name, value] of Object.entries(extra)) {
    if (FAMILY_CLAIMS.has(name)) throw fault(`a claim name other than ${name}, which the pass family owns`)
    requiredCredentialField(value, name, fault)
  }
  const ttl = lifetimeSeconds(input.ttlSeconds, fault)
  const { alg, key } = await runtimeTokenSigningKey(env, fault)
  const kid = await resolveMintKid(env, key)
  const now = Math.floor((input.now?.() ?? Date.now()) / 1_000)
  const jti = randomToken()
  const token = await new SignJWT({
    ...extra,
    [SCOPE_CLAIMS.userId]: scope.userId,
    [SCOPE_CLAIMS.orgId]: scope.orgId,
    [SCOPE_CLAIMS.workspaceId]: scope.workspaceId,
    ...(scope.projectId === undefined ? {} : { [SCOPE_CLAIMS.projectId]: scope.projectId }),
    ...(scope.sessionId === undefined ? {} : { [SCOPE_CLAIMS.sessionId]: scope.sessionId }),
    operations: [...input.operations],
  })
    .setProtectedHeader({ alg, kid })
    .setIssuer(runtimeAccessTokenIssuer)
    .setAudience(input.audience)
    .setSubject(scope.userId)
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .setJti(jti)
    .sign(key)
  const expiresAt = (now + ttl) * 1_000
  await input.register?.record({ jti, audience: input.audience, scope, issuedAt: now * 1_000, expiresAt })
  return { token, jti, expiresAt }
}

function claimString(payload: JWTPayload, name: string) {
  const value = payload[name]
  return typeof value === "string" && value ? value : undefined
}

function passScope(payload: JWTPayload): SandboxPassScope | undefined {
  const userId = claimString(payload, SCOPE_CLAIMS.userId)
  const orgId = claimString(payload, SCOPE_CLAIMS.orgId)
  const workspaceId = claimString(payload, SCOPE_CLAIMS.workspaceId)
  if (!userId || !orgId || !workspaceId || payload.sub !== userId) return undefined
  const scope: { -readonly [K in keyof SandboxPassScope]: SandboxPassScope[K] } = { userId, orgId, workspaceId }
  for (const name of ["projectId", "sessionId"] as const) {
    const claim = SCOPE_CLAIMS[name]
    if (payload[claim] === undefined) continue
    const value = claimString(payload, claim)
    if (!value) return undefined
    scope[name] = value
  }
  return scope
}

function passOperations(payload: JWTPayload): readonly string[] | undefined {
  const value = payload.operations
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length === 0) return undefined
  return value.every((item): item is string => typeof item === "string" && item !== "") ? value : undefined
}

export async function verifySandboxPass(
  token: string,
  env: Record<string, string | undefined>,
  options: {
    audience: string
    fault: CredentialFault
    now?: () => number
    /** Asked only for a well-signed, unexpired pass; a verifier given none answers for the signature alone. */
    revoked?: (jti: string) => Promise<boolean>
  },
): Promise<SandboxPass> {
  const { key } = await runtimeTokenVerificationKey(env, options.fault)
  const { payload } = await jwtVerify(token, key, {
    algorithms: [RUNTIME_ACCESS_TOKEN_ALGORITHM],
    issuer: runtimeAccessTokenIssuer,
    audience: options.audience,
    requiredClaims: ["sub", "iat", "exp"],
    ...(options.now ? { currentDate: new Date(options.now()) } : {}),
  })
  const jti = claimString(payload, "jti")
  if (!jti) throw new SandboxPassError(options.audience, "has no jti")
  if (options.revoked && (await options.revoked(jti))) throw new SandboxPassError(options.audience, "was revoked")
  const { iat, exp } = payload
  if (iat === undefined || exp === undefined) throw new SandboxPassError(options.audience, "has no lifetime")
  const scope = passScope(payload)
  const operations = passOperations(payload)
  if (!scope || !operations) throw new SandboxPassError(options.audience, "scope is invalid")
  const extra: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(payload)) {
    if (!FAMILY_CLAIMS.has(name)) extra[name] = value
  }
  return {
    audience: options.audience,
    scope,
    operations,
    extra,
    jti,
    issuedAt: iat * 1_000,
    expiresAt: exp * 1_000,
  }
}
