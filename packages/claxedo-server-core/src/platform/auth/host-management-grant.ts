import { errors, type JWTVerifyGetKey } from "jose"
import { credentialFault } from "./runtime-token-keys"
import { mintSandboxPass, SandboxPassError, verifyScopedPassWith } from "./sandbox-pass"

/**
 * What a connected machine requires, beside the relay's proof of who is
 * asking, before it reads its folders or writes a new checkout: the control
 * plane's word that this person owns this enrollment and asked for this one
 * operation at this one destination, within the last minute. A workspace token
 * reaches one workspace and says nothing about the machine around it, so it
 * never stands in for this grant, and this grant reaches no workspace route.
 */
export const HOST_MANAGEMENT_GRANT_AUDIENCE = "claxedo-host-management"

export const HOST_MANAGEMENT_GRANT_HEADER = "x-claxedo-host-grant"

export const HOST_MANAGEMENT_OPERATIONS = ["folders.read", "clone", "worktree"] as const

export type HostManagementOperation = (typeof HOST_MANAGEMENT_OPERATIONS)[number]

/** Where a connected machine answers each operation, under the workspace it is reached through. */
export const HOST_MANAGEMENT_ROUTES = {
  "folders.read": "/host-management/folders",
  clone: "/host-management/clone",
  worktree: "/host-management/worktree",
} as const satisfies Record<HostManagementOperation, string>

export const HOST_MANAGEMENT_GRANT_TTL_SECONDS = 60

const CLOCK_TOLERANCE_SECONDS = 30

export class HostManagementGrantConfigurationError extends Error {
  readonly code = "host_management_grant_misconfigured"
}

const fault = credentialFault("host management grant", HostManagementGrantConfigurationError)

export type HostManagementGrant = {
  ownerUserId: string
  orgId: string
  enrollmentId: string
  hostId: string
  operation: HostManagementOperation
  destination: string
  jti: string
  expiresAt: number
}

function isOperation(value: unknown): value is HostManagementOperation {
  return HOST_MANAGEMENT_OPERATIONS.some((operation) => operation === value)
}

export async function mintHostManagementGrant(
  input: Omit<HostManagementGrant, "jti" | "expiresAt">,
  env: Record<string, string | undefined>,
  options: { now?: () => number } = {},
): Promise<{ token: string; expiresAt: number }> {
  const minted = await mintSandboxPass({
    audience: HOST_MANAGEMENT_GRANT_AUDIENCE,
    scope: { userId: input.ownerUserId, orgId: input.orgId, enrollmentId: input.enrollmentId },
    operations: [input.operation],
    extra: { host_id: input.hostId, destination: input.destination },
    ttlSeconds: HOST_MANAGEMENT_GRANT_TTL_SECONDS,
    ...(options.now ? { now: options.now } : {}),
  }, env, fault)
  return { token: minted.token, expiresAt: minted.expiresAt }
}

/** The grant's claims when it is well signed under the plane's published key set, unexpired and names one known operation; nothing otherwise. */
export async function verifyHostManagementGrant(
  token: string,
  key: JWTVerifyGetKey,
  options: { now?: () => number } = {},
): Promise<HostManagementGrant | undefined> {
  try {
    const pass = await verifyScopedPassWith(token, key, {
      audience: HOST_MANAGEMENT_GRANT_AUDIENCE,
      fault,
      clockToleranceSeconds: CLOCK_TOLERANCE_SECONDS,
      ...(options.now ? { now: options.now } : {}),
    })
    const { scope, extra, operations } = pass
    const [operation] = operations
    if (!("enrollmentId" in scope) || operations.length !== 1 || !isOperation(operation)) return undefined
    const hostId = extra.host_id
    const destination = extra.destination
    if (typeof hostId !== "string" || !hostId || typeof destination !== "string" || !destination) return undefined
    return {
      ownerUserId: scope.userId,
      orgId: scope.orgId,
      enrollmentId: scope.enrollmentId,
      hostId,
      operation,
      destination,
      jti: pass.jti,
      expiresAt: pass.expiresAt,
    }
  } catch (error) {
    if (error instanceof SandboxPassError || error instanceof errors.JOSEError) return undefined
    throw error
  }
}
