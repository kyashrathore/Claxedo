import { object } from "../json"

/**
 * Reads a bearer token's payload without verifying it. The CLI only uses this
 * for display (`whoami`) and expiry hints, never for authorization decisions,
 * so an unparsable token yields an empty payload instead of throwing.
 */
export function jwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1]
  if (!part) return {}
  try {
    return object(JSON.parse(Buffer.from(part, "base64url").toString("utf8")))
  } catch {
    return {}
  }
}

/** Token expiry in epoch milliseconds, when the payload carries a numeric `exp`. */
export function jwtExpiresAt(token: string): number | undefined {
  const exp = jwtPayload(token).exp
  return typeof exp === "number" ? exp * 1000 : undefined
}
