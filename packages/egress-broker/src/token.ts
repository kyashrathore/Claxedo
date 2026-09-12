import { jwtVerify, SignJWT } from "jose"
import type { RuntimeIdentity } from "./binding.js"

export type RuntimeTokenClaims = RuntimeIdentity & { bindingIds: string[]; exp: number }
const audience = "claxedo-egress-broker"
const issuer = "claxedo-runtime-authority"

function hasRuntimeIdentityClaims(value: Record<string, unknown>): value is Record<string, unknown> & RuntimeIdentity {
  return ["userId", "orgId", "workspaceId", "leaseId", "runtimeId"]
    .every((key) => typeof value[key] === "string" && value[key] !== "")
    && Number.isSafeInteger(value.leaseGeneration) && Number(value.leaseGeneration) > 0
}

export async function mintRuntimeToken(input: RuntimeIdentity & {
  bindingIds: string[]
  expiresAt: number
}, key: Uint8Array, now = Date.now()) {
  if (key.byteLength < 32) throw new Error("Runtime token signing key must be at least 32 bytes")
  if (!hasRuntimeIdentityClaims(input) || !input.bindingIds.length || input.bindingIds.some((id) => !id)) {
    throw new Error("Invalid runtime token scope")
  }
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now) throw new Error("Invalid runtime token expiry")
  const { expiresAt, ...claims } = input
  return new SignJWT(claims).setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(issuer).setAudience(audience).setSubject(input.runtimeId)
    .setIssuedAt(Math.floor(now / 1000)).setExpirationTime(Math.floor(expiresAt / 1000)).sign(key)
}

export async function verifyRuntimeToken(token: string, key: Uint8Array, now = Date.now()): Promise<RuntimeTokenClaims | undefined> {
  if (key.byteLength < 32) return undefined
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"], issuer, audience, currentDate: new Date(now), requiredClaims: ["exp", "iat", "sub"] })
    if (!hasRuntimeIdentityClaims(payload) || payload.sub !== payload.runtimeId || !Array.isArray(payload.bindingIds)
      || !payload.bindingIds.length || !payload.bindingIds.every((id): id is string => typeof id === "string" && !!id)
      || typeof payload.exp !== "number" || !Number.isSafeInteger(payload.exp)) return undefined
    return {
      userId: payload.userId, orgId: payload.orgId, workspaceId: payload.workspaceId,
      leaseId: payload.leaseId, leaseGeneration: payload.leaseGeneration, runtimeId: payload.runtimeId,
      bindingIds: payload.bindingIds, exp: payload.exp,
    }
  } catch {
    return undefined
  }
}
