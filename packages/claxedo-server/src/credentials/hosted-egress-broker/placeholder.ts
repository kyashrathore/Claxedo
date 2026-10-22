import { createHash } from "node:crypto"
import { errors } from "jose"
import type { RuntimeIdentity, RuntimeTokenClaims } from "@claxedo/egress-broker"
import { credentialFault } from "@claxedo/server-core/platform/auth/runtime-token-keys"
import { mintSandboxPass, SandboxPassError, verifyScopedPass } from "@claxedo/server-core/platform/auth/sandbox-pass"

export const EGRESS_BROKER_PASS_AUDIENCE = "claxedo-egress-broker" as const

/** The one thing a placeholder does: spend the account its binding names, through the broker. */
const OPERATIONS = ["spend"] as const

/** A pass lives an hour, the ceiling of the pass family; the runtime is re-delivered a fresh one at half-life. */
export const PLACEHOLDER_TTL_SECONDS = 60 * 60

export class EgressBrokerConfigurationError extends Error {
  readonly code = "egress_broker_misconfigured"
}

const fault = credentialFault("egress broker placeholder", EgressBrokerConfigurationError)

/**
 * What the runtime a placeholder is minted for serves: one workspace, for a
 * sandbox, or a connected machine's enrollment, under which that machine
 * serves every workspace its owner assigns it.
 */
export type BrokerServing =
  | { workspaceId: string; enrollmentId?: undefined }
  | { workspaceId?: undefined; enrollmentId: string }

export type HostedBrokerIdentity = RuntimeIdentity & BrokerServing

/**
 * The claims a hosted placeholder carries beyond the runtime identity: which
 * stored account it was minted for. The broker reads that account by id on
 * every request, so a placeholder minted before an account switch names the
 * account the operator moved off and is refused once that row is gone, and
 * answers the moved-off account only while the owner still holds it.
 */
export type HostedBrokerClaims = RuntimeTokenClaims & BrokerServing & { credentialId: string }

/**
 * A binding names a provider under a workspace for one identity, never an
 * account: its id survives every account switch and rotation, so a harness
 * that keys on the binding URL (Codex composes its home per `baseUrl`) keeps
 * the same URL across the placeholders delivered to it.
 */
export function brokerBindingId(input: { userId: string; orgId: string; workspaceId: string; providerId: string }): string {
  return createHash("sha256").update(JSON.stringify([input.userId, input.orgId, input.workspaceId, input.providerId])).digest("hex").slice(0, 32)
}

/**
 * A connected machine's binding: one provider under the machine's
 * enrollment, for every workspace the machine serves. It hashes five names
 * where a workspace binding hashes four, so no machine binding can share a
 * workspace binding's id.
 */
export function machineBindingId(input: { userId: string; orgId: string; enrollmentId: string; providerId: string }): string {
  return createHash("sha256").update(JSON.stringify(["machine", input.userId, input.orgId, input.enrollmentId, input.providerId])).digest("hex").slice(0, 32)
}

/** The binding id a placeholder minted for this identity carries for one provider. */
export function servingBindingId(identity: { userId: string; orgId: string } & BrokerServing, providerId: string): string {
  return identity.enrollmentId === undefined
    ? brokerBindingId({ userId: identity.userId, orgId: identity.orgId, workspaceId: identity.workspaceId, providerId })
    : machineBindingId({ userId: identity.userId, orgId: identity.orgId, enrollmentId: identity.enrollmentId, providerId })
}

/** A workspace's repository binding: derived under a name no stored account carries, so no account binding shares its id. */
export function repositoryBindingId(identity: { userId: string; orgId: string; workspaceId: string }): string {
  return brokerBindingId({ ...identity, providerId: "github-repository" })
}

const CLAIM = {
  bindingId: "binding_id",
  credentialId: "credential_id",
  leaseId: "lease_id",
  leaseGeneration: "lease_generation",
  runtimeId: "runtime_id",
} as const

export async function mintBrokerPlaceholder(
  input: {
    identity: HostedBrokerIdentity
    bindingId: string
    credentialId: string
    /** Claims the destination asks its stand-in to carry (`ProviderDestination.standInClaims`). */
    claims?: Readonly<Record<string, Readonly<Record<string, string>>>>
  },
  env: Record<string, string | undefined>,
  options: { now?: () => number } = {},
): Promise<{ placeholder: string; expiresAt: number }> {
  const { identity } = input
  const minted = await mintSandboxPass({
    audience: EGRESS_BROKER_PASS_AUDIENCE,
    scope: identity.enrollmentId === undefined
      ? { userId: identity.userId, orgId: identity.orgId, workspaceId: identity.workspaceId }
      : { userId: identity.userId, orgId: identity.orgId, enrollmentId: identity.enrollmentId },
    operations: OPERATIONS,
    extra: {
      ...input.claims,
      [CLAIM.bindingId]: input.bindingId,
      [CLAIM.credentialId]: input.credentialId,
      [CLAIM.leaseId]: identity.leaseId,
      [CLAIM.leaseGeneration]: String(identity.leaseGeneration),
      [CLAIM.runtimeId]: identity.runtimeId,
    },
    ttlSeconds: PLACEHOLDER_TTL_SECONDS,
    ...(options.now ? { now: options.now } : {}),
  }, env, fault)
  return { placeholder: minted.token, expiresAt: minted.expiresAt }
}

function extraClaim(extra: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const value = extra[name]
  return typeof value === "string" && value ? value : undefined
}

/**
 * The claims of a well-signed, unexpired placeholder, or nothing. A pass the
 * plane cannot verify is a 401 to the broker whatever the cause, and a plane
 * without its signing key answers every placeholder that way until the key
 * is configured.
 */
export async function verifyBrokerPlaceholder(
  token: string,
  env: Record<string, string | undefined>,
  options: { now?: () => number } = {},
): Promise<HostedBrokerClaims | undefined> {
  try {
    const pass = await verifyScopedPass(token, env, { audience: EGRESS_BROKER_PASS_AUDIENCE, fault, ...(options.now ? { now: options.now } : {}) })
    if (!pass.operations.includes(OPERATIONS[0])) return undefined
    const bindingId = extraClaim(pass.extra, CLAIM.bindingId)
    const credentialId = extraClaim(pass.extra, CLAIM.credentialId)
    const leaseId = extraClaim(pass.extra, CLAIM.leaseId)
    const runtimeId = extraClaim(pass.extra, CLAIM.runtimeId)
    const leaseGeneration = Number(extraClaim(pass.extra, CLAIM.leaseGeneration))
    if (!bindingId || !credentialId || !leaseId || !runtimeId || !Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) return undefined
    const scope = pass.scope
    return {
      userId: scope.userId,
      orgId: scope.orgId,
      ...("enrollmentId" in scope ? { enrollmentId: scope.enrollmentId } : { workspaceId: scope.workspaceId }),
      leaseId,
      leaseGeneration,
      runtimeId,
      bindingIds: [bindingId],
      exp: Math.floor(pass.expiresAt / 1_000),
      credentialId,
    }
  } catch (error) {
    if (error instanceof EgressBrokerConfigurationError || error instanceof SandboxPassError || error instanceof errors.JOSEError) return undefined
    throw error
  }
}
