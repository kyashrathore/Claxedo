import { createHash } from "node:crypto"
import { errors } from "jose"
import type { RuntimeIdentity, RuntimeTokenClaims } from "@claxedo/egress-broker"
import { credentialFault } from "../../platform/auth/runtime-token-keys"
import { mintSandboxPass, SandboxPassError, verifySandboxPass } from "../../platform/auth/sandbox-pass"

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
 * The claims a hosted placeholder carries beyond the runtime identity: which
 * stored account it was minted for. The broker reads that account by id on
 * every request, so a placeholder minted before an account switch names the
 * account the operator moved off and is refused once that row is gone, and
 * answers the moved-off account only while the owner still holds it.
 */
export type HostedBrokerClaims = RuntimeTokenClaims & { credentialId: string }

/**
 * A binding names a provider under a workspace for one identity, never an
 * account: its id survives every account switch and rotation, so the URL a
 * harness froze at launch (the Cursor SDK reads it once) keeps pointing at
 * the binding the next placeholder names.
 */
export function brokerBindingId(input: { userId: string; orgId: string; workspaceId: string; providerId: string }): string {
  return createHash("sha256").update(JSON.stringify([input.userId, input.orgId, input.workspaceId, input.providerId])).digest("hex").slice(0, 32)
}

const CLAIM = {
  bindingId: "binding_id",
  credentialId: "credential_id",
  leaseId: "lease_id",
  leaseGeneration: "lease_generation",
  runtimeId: "runtime_id",
} as const

export async function mintBrokerPlaceholder(
  input: { identity: RuntimeIdentity; bindingId: string; credentialId: string },
  env: Record<string, string | undefined>,
  options: { now?: () => number } = {},
): Promise<{ placeholder: string; expiresAt: number }> {
  const { identity } = input
  const minted = await mintSandboxPass({
    audience: EGRESS_BROKER_PASS_AUDIENCE,
    scope: { userId: identity.userId, orgId: identity.orgId, workspaceId: identity.workspaceId },
    operations: OPERATIONS,
    extra: {
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
    const pass = await verifySandboxPass(token, env, { audience: EGRESS_BROKER_PASS_AUDIENCE, fault, ...(options.now ? { now: options.now } : {}) })
    if (!pass.operations.includes(OPERATIONS[0])) return undefined
    const bindingId = extraClaim(pass.extra, CLAIM.bindingId)
    const credentialId = extraClaim(pass.extra, CLAIM.credentialId)
    const leaseId = extraClaim(pass.extra, CLAIM.leaseId)
    const runtimeId = extraClaim(pass.extra, CLAIM.runtimeId)
    const leaseGeneration = Number(extraClaim(pass.extra, CLAIM.leaseGeneration))
    if (!bindingId || !credentialId || !leaseId || !runtimeId || !Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) return undefined
    return {
      userId: pass.scope.userId,
      orgId: pass.scope.orgId,
      workspaceId: pass.scope.workspaceId,
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
