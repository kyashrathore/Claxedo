import { isRecord } from "./guards"

/**
 * Parses a JSON string to a plain object. Non-string input, malformed JSON,
 * and a document whose top level is an array or primitive are all `undefined`;
 * narrowing the fields is the caller's job.
 */
export function jsonRecord(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== "string" || input.length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(input)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Fetch-API only, so it stays valid on workerd. The body may be read once, so
 * callers must not call this twice on the same Request.
 */
export async function jsonObject(req: Request): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await req.json()
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Byte-equality of the JSON encoding, NOT structural equality: key order and
 * element order are both significant. `undefined` on either side is false,
 * which makes explicit what four of the copies got implicitly from
 * `JSON.stringify(undefined) === undefined`.
 *
 * The order-independent notion is a different helper — `canonicalJson` in
 * workspace-runtime — and the two must keep different names.
 */
export function sameJson(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return false
  return JSON.stringify(left) === JSON.stringify(right)
}
