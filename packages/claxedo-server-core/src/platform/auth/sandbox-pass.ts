import { jwtVerify, SignJWT, type JWTPayload, type JWTVerifyGetKey } from "jose"
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
 * verify: the Tasks capability, the owner grant, the Agent Plugins gateway
 * token and the egress broker's placeholder among them.
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
 * The hosted egress broker's placeholder is one of them: a pass for the
 * `claxedo-egress-broker` audience naming the binding and the stored account
 * it spends. The runtime's own HS256 session credential is not: it is minted inside the
 * sandbox and never presented to this plane.
 *
 * A connected machine's placeholder is the one pass that names no workspace:
 * it names the machine's enrollment instead ({@link MachinePassScope}), since
 * one machine serves every workspace its owner assigns it under one
 * enrollment. Only {@link verifyScopedPass} reads such a pass;
 * {@link verifySandboxPass} refuses it, so no audience that expects a
 * workspace is ever handed one.
 */
export type SandboxPassScope = Readonly<{
  userId: string
  orgId: string
  workspaceId: string
  projectId?: string
  sessionId?: string
}>

/** A connected machine's pass: one user, one organization and the machine's enrollment, in place of a workspace. */
export type MachinePassScope = Readonly<{
  userId: string
  orgId: string
  enrollmentId: string
}>

export type SandboxPassInput = Readonly<{
  audience: string
  operations: readonly string[]
  /**
   * Claims beyond the scope, under the audience's own names; none may reuse a
   * family claim name. A claim is a string, or a record of strings for a
   * client that reads a nested claim off the token it is handed.
   */
  extra?: Readonly<Record<string, string | Readonly<Record<string, string>>>>
  scope: SandboxPassScope | MachinePassScope
  ttlSeconds?: number
  now?: () => number
  /**
   * Where the minted `jti` is written down, so the pass can be taken back
   * before it expires. The register finds passes by workspace, so a machine's
   * pass, which names none, is refused one.
   */
  register?: SandboxPassRegister
}>

export type ScopedPass<Scope extends SandboxPassScope | MachinePassScope> = Readonly<{
  audience: string
  scope: Scope
  /** Empty only for a token carrying no `operations` claim; whether that is acceptable is the audience's rule. */
  operations: readonly string[]
  extra: Readonly<Record<string, unknown>>
  jti: string
  issuedAt: number
  expiresAt: number
}>

export type SandboxPass = ScopedPass<SandboxPassScope>

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
  enrollmentId: "enrollment_id",
} as const

const FAMILY_CLAIMS = new Set<string>([...Object.values(SCOPE_CLAIMS), "operations", "iss", "aud", "sub", "jti", "iat", "exp", "nbf"])

function lifetimeSeconds(requested: number | undefined, fault: CredentialFault) {
  if (requested === undefined) return SANDBOX_PASS_DEFAULT_TTL_SECONDS
  if (!Number.isFinite(requested)) throw fault("a finite ttlSeconds")
  return Math.min(SANDBOX_PASS_MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Math.floor(requested)))
}

function passScopeClaims(scope: SandboxPassScope | MachinePassScope, fault: CredentialFault): Record<string, string> {
  for (const name of ["userId", "orgId"] as const) requiredCredentialField(scope[name], name, fault)
  if ("enrollmentId" in scope) {
    return {
      [SCOPE_CLAIMS.userId]: scope.userId,
      [SCOPE_CLAIMS.orgId]: scope.orgId,
      [SCOPE_CLAIMS.enrollmentId]: requiredCredentialField(scope.enrollmentId, "enrollmentId", fault),
    }
  }
  requiredCredentialField(scope.workspaceId, "workspaceId", fault)
  for (const name of ["projectId", "sessionId"] as const) {
    if (scope[name] !== undefined) requiredCredentialField(scope[name], name, fault)
  }
  return {
    [SCOPE_CLAIMS.userId]: scope.userId,
    [SCOPE_CLAIMS.orgId]: scope.orgId,
    [SCOPE_CLAIMS.workspaceId]: scope.workspaceId,
    ...(scope.projectId === undefined ? {} : { [SCOPE_CLAIMS.projectId]: scope.projectId }),
    ...(scope.sessionId === undefined ? {} : { [SCOPE_CLAIMS.sessionId]: scope.sessionId }),
  }
}

export async function mintSandboxPass(input: SandboxPassInput, env: Record<string, string | undefined>, fault: CredentialFault) {
  const { scope, extra = {} } = input
  requiredCredentialField(input.audience, "audience", fault)
  const claims = passScopeClaims(scope, fault)
  if (input.register && "enrollmentId" in scope) throw fault("a workspace scope to be written to a register")
  if (input.operations.length === 0) throw fault("at least one operation")
  for (const operation of input.operations) requiredCredentialField(operation, "operation", fault)
  for (const [name, value] of Object.entries(extra)) {
    if (FAMILY_CLAIMS.has(name)) throw fault(`a claim name other than ${name}, which the pass family owns`)
    if (typeof value === "string") requiredCredentialField(value, name, fault)
    else for (const [member, nested] of Object.entries(value)) requiredCredentialField(nested, `${name}.${member}`, fault)
  }
  const ttl = lifetimeSeconds(input.ttlSeconds, fault)
  const { alg, key } = await runtimeTokenSigningKey(env, fault)
  const kid = await resolveMintKid(env, key)
  const now = Math.floor((input.now?.() ?? Date.now()) / 1_000)
  const jti = randomToken()
  const token = await new SignJWT({
    ...extra,
    ...claims,
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
  if (!("enrollmentId" in scope)) await input.register?.record({ jti, audience: input.audience, scope, issuedAt: now * 1_000, expiresAt })
  return { token, jti, expiresAt }
}

function claimString(payload: JWTPayload, name: string) {
  const value = payload[name]
  return typeof value === "string" && value ? value : undefined
}

/** A workspace's scope or a machine's, never both: a pass naming a workspace and an enrollment says nothing trustworthy about either. */
function passScope(payload: JWTPayload): SandboxPassScope | MachinePassScope | undefined {
  const userId = claimString(payload, SCOPE_CLAIMS.userId)
  const orgId = claimString(payload, SCOPE_CLAIMS.orgId)
  if (!userId || !orgId || payload.sub !== userId) return undefined
  if (payload[SCOPE_CLAIMS.workspaceId] === undefined) {
    const enrollmentId = claimString(payload, SCOPE_CLAIMS.enrollmentId)
    if (!enrollmentId || payload[SCOPE_CLAIMS.projectId] !== undefined || payload[SCOPE_CLAIMS.sessionId] !== undefined) return undefined
    return { userId, orgId, enrollmentId }
  }
  const workspaceId = claimString(payload, SCOPE_CLAIMS.workspaceId)
  if (!workspaceId || payload[SCOPE_CLAIMS.enrollmentId] !== undefined) return undefined
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

type PassVerification = {
  audience: string
  fault: CredentialFault
  now?: () => number
  /** Seconds of clock difference forgiven on `iat` and `exp`, for a verifier on another machine than the signer. */
  clockToleranceSeconds?: number
  /** Asked only for a well-signed, unexpired pass; a verifier given none answers for the signature alone. */
  revoked?: (jti: string) => Promise<boolean>
}

/** A pass that names a workspace; a machine's pass is refused, so an audience that expects a workspace always has one. */
export async function verifySandboxPass(
  token: string,
  env: Record<string, string | undefined>,
  options: PassVerification,
): Promise<SandboxPass> {
  const pass = await verifyScopedPass(token, env, options)
  const scope = pass.scope
  if ("enrollmentId" in scope) throw new SandboxPassError(options.audience, "scope is invalid")
  return { ...pass, scope }
}

/** A pass that names a workspace or a connected machine's enrollment, for the one audience that serves both. */
export async function verifyScopedPass(
  token: string,
  env: Record<string, string | undefined>,
  options: PassVerification,
): Promise<ScopedPass<SandboxPassScope | MachinePassScope>> {
  const { key } = await runtimeTokenVerificationKey(env, options.fault)
  return await verifyScopedPassWith(token, async () => key, options)
}

/**
 * The same reading of a pass, for a verifier holding the control plane's
 * published key set instead of its configured public key: a process on
 * another machine than the plane.
 */
export async function verifyScopedPassWith(
  token: string,
  key: JWTVerifyGetKey,
  options: PassVerification,
): Promise<ScopedPass<SandboxPassScope | MachinePassScope>> {
  const { payload } = await jwtVerify(token, key, {
    algorithms: [RUNTIME_ACCESS_TOKEN_ALGORITHM],
    issuer: runtimeAccessTokenIssuer,
    audience: options.audience,
    requiredClaims: ["sub", "iat", "exp"],
    ...(options.now ? { currentDate: new Date(options.now()) } : {}),
    ...(options.clockToleranceSeconds ? { clockTolerance: options.clockToleranceSeconds } : {}),
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
