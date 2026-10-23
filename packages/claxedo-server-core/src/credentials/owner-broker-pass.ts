import { errors, type JWTVerifyGetKey } from "jose"
import { credentialFault } from "../platform/auth/runtime-token-keys"
import { mintSandboxPass, SandboxPassError, verifyScopedPassWith } from "../platform/auth/sandbox-pass"

/**
 * What a `claxedo connect` machine presents to its owner's desktop broker
 * with every model call it sends there: the control plane's word, at the
 * machine's latest beat, that its enrollment is one the hosted broker would
 * admit (live, unpaused, its owner an active member of the organization it was
 * invited into), naming the key its direct listener holds.
 *
 * The desktop cannot ask the plane per request as the hosted broker does, so
 * the pass is short: a machine revoked or paused stops receiving one, and the
 * last it holds is refused a minute after it was minted.
 */
export const OWNER_BROKER_PASS_AUDIENCE = "claxedo-owner-broker"

const OPERATION = "spend-through-owner"

/** The pass family's floor; a machine beats every 20 s, so two beats may fail before one lapses. */
export const OWNER_BROKER_PASS_TTL_SECONDS = 60

const CLOCK_TOLERANCE_SECONDS = 30

export class OwnerBrokerPassConfigurationError extends Error {
  readonly code = "owner_broker_pass_misconfigured"
}

const fault = credentialFault("owner broker pass", OwnerBrokerPassConfigurationError)

export type OwnerBrokerPass = {
  ownerUserId: string
  orgId: string
  enrollmentId: string
  hostId: string
  /** The SHA-256 of the machine's direct listener key, as the desktop pins it. */
  spkiSha256: string
  expiresAt: number
}

export async function mintOwnerBrokerPass(
  input: Omit<OwnerBrokerPass, "expiresAt">,
  env: Record<string, string | undefined>,
  options: { now?: () => number } = {},
): Promise<{ token: string; expiresAt: number }> {
  const minted = await mintSandboxPass({
    audience: OWNER_BROKER_PASS_AUDIENCE,
    scope: { userId: input.ownerUserId, orgId: input.orgId, enrollmentId: input.enrollmentId },
    operations: [OPERATION],
    extra: { host_id: input.hostId, spki_sha256: input.spkiSha256 },
    ttlSeconds: OWNER_BROKER_PASS_TTL_SECONDS,
    ...(options.now ? { now: options.now } : {}),
  }, env, fault)
  return { token: minted.token, expiresAt: minted.expiresAt }
}

/** The pass's claims when it is well signed under the plane's published key set and unexpired; nothing otherwise. */
export async function verifyOwnerBrokerPass(
  token: string,
  key: JWTVerifyGetKey,
  options: { now?: () => number } = {},
): Promise<OwnerBrokerPass | undefined> {
  try {
    const pass = await verifyScopedPassWith(token, key, {
      audience: OWNER_BROKER_PASS_AUDIENCE,
      fault,
      clockToleranceSeconds: CLOCK_TOLERANCE_SECONDS,
      ...(options.now ? { now: options.now } : {}),
    })
    const { scope, extra } = pass
    if (!("enrollmentId" in scope) || !pass.operations.includes(OPERATION)) return undefined
    const hostId = extra.host_id
    const spkiSha256 = extra.spki_sha256
    if (typeof hostId !== "string" || !hostId || typeof spkiSha256 !== "string" || !spkiSha256) return undefined
    return { ownerUserId: scope.userId, orgId: scope.orgId, enrollmentId: scope.enrollmentId, hostId, spkiSha256, expiresAt: pass.expiresAt }
  } catch (error) {
    if (error instanceof SandboxPassError || error instanceof errors.JOSEError) return undefined
    throw error
  }
}
