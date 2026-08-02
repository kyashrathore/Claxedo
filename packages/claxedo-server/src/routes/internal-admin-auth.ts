import { timingSafeEqualStrings } from "../authority/web-crypto"

export function internalAdminAuthorized(request: Request, expected: string | undefined) {
  const header = request.headers.get("authorization")
  const secret = expected?.trim()
  if (!secret || !header) return false
  const presented = /^Bearer\s+(.+)$/i.exec(header.trim())?.[1]?.trim()
  return presented ? timingSafeEqualStrings(presented, secret) : false
}
