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

/**
 * Snapshot state may contain structured-clone-safe values such as Date, Map,
 * BigInt, arrays, and circular references. If structuredClone is unavailable
 * for a value, the fallback intentionally constrains that value to JSON-safe
 * data: functions/symbols are dropped, BigInts become strings, and circular
 * references are marked instead of throwing.
 */
export function cloneSnapshotValue<T>(value: T): T
// The JSON fallback deliberately degrades values `structuredClone` rejects, so
// the implementation is typed at the boundary it actually honours (`unknown`)
// and the overload above states the contract callers rely on.
export function cloneSnapshotValue(value: unknown): unknown {
  if (value === undefined || value === null) return value
  try {
    return structuredClone(value)
  } catch {
    const seen = new WeakSet<object>()
    const json = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "bigint") return item.toString()
      if (typeof item === "function" || typeof item === "symbol") return undefined
      if (item && typeof item === "object") {
        if (seen.has(item)) return "[Circular]"
        seen.add(item)
      }
      return item
    })
    return json === undefined ? undefined : JSON.parse(json)
  }
}
