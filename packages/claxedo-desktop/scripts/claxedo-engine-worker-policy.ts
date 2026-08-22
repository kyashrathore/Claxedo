import { timingSafeEqual } from "node:crypto"

export function isAuthorizedEngineWorkerRequest(header: string | string[] | undefined, token: string) {
  if (typeof header !== "string") return false
  const actual = Buffer.from(header)
  const expected = Buffer.from(`Bearer ${token}`)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function sessionStatusHasActiveWork(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return true
  return Object.values(input).some((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return true
    return (value as { type?: unknown }).type !== "idle"
  })
}
