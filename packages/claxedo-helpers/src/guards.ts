/**
 * Narrowing primitives. Zero imports and no host APIs, so this module is valid
 * in the browser/Electron renderer, on Node/Bun, and on workerd alike — the
 * `./guards` subpath exists so a `.cf.ts` worker module can reach it without
 * pulling the package root.
 */

/** Runtime tag for contract-violation messages. No caller branches on it. */
export function typeOf(
  value: unknown,
): "null" | "array" | "string" | "number" | "bigint" | "boolean" | "symbol" | "undefined" | "object" | "function" {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

/**
 * Rejects arrays; accepts Date/Map/class instances, because none of the copies
 * this replaces added a prototype check and `isRecord(new Date())` narrowing is
 * load-bearing at several of them.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** The same object reference, never a copy. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

/**
 * Total form. The `{}` is a fresh literal per call, so a caller may mutate it;
 * it is not a shared singleton.
 */
export function asRecordOrEmpty(value: unknown): Record<string, unknown> {
  return asRecord(value) ?? {}
}

export function assertRecord(value: unknown, label: string): Record<string, unknown> {
  const record = asRecord(value)
  if (!record) throw new Error(`${label} must be an object`)
  return record
}

export function isString(value: unknown): value is string {
  return typeof value === "string"
}

/** Returns the original string, including "". Does not trim. */
export function asString(value: unknown): string | undefined {
  return isString(value) ? value : undefined
}

/** Does not trim, so a whitespace-only string passes. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

export function nonEmptyString(value: unknown): string | undefined {
  return isNonEmptyString(value) ? value : undefined
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

/** Preserves 0 and -0, so callers must use `??`, never truthiness. */
export function asFiniteNumber(value: unknown): number | undefined {
  return isFiniteNumber(value) ? value : undefined
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean"
}

/** Rejects 0/1 and "true"/"false"; only a boolean primitive passes. */
export function asBoolean(value: unknown): boolean | undefined {
  return isBoolean(value) ? value : undefined
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

export function assertNonNegativeSafeInteger(name: string, value: number): void {
  if (!isNonNegativeSafeInteger(value)) throw new Error(`${name} must be a non-negative integer`)
}

/**
 * Returns the ORIGINAL, untrimmed string. Callers compare the result
 * byte-exactly against an expected identity (host_id, iss, aud), so trimming
 * would let a whitespace-padded claim satisfy an exact-identity check.
 */
export function stringClaim(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key]
  return isString(value) && value.trim().length > 0 ? value : undefined
}

export function numberClaim(payload: Record<string, unknown>, key: string): number | undefined {
  return asFiniteNumber(payload[key])
}

/**
 * Returns the input BY REFERENCE when it is an array, so mutating the result
 * mutates the source. `Array.isArray` recognises cross-realm arrays arriving
 * over structured clone, an iframe, or Electron IPC.
 */
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : []
}
