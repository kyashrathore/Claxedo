/**
 * Total readers for untyped JSON-ish payloads reaching this package.
 *
 * Several boundaries hand TypeScript nothing: CDP (`Debugger.sendCommand`
 * resolves to `unknown`, and the `message` event's `params` is whatever the
 * browser sent), the agent-browser HTTP bridge (request bodies are
 * `JSON.parse` output), the Host Connector child message port, and the
 * on-disk machine-identity record. Each used to declare a hand-written shape
 * per call site and cast the payload to it, which asserts a contract the
 * remote end never promised.
 *
 * These readers are the single place that decision is made: they never throw,
 * never assert, and return `undefined` for anything that is not present in
 * the expected shape. Callers compose them into one parse per payload.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The record form of {@link isRecord}, for composing into an expression. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

export function readUnknown(source: unknown, key: string): unknown {
  return isRecord(source) ? source[key] : undefined
}

export function readString(source: unknown, key: string): string | undefined {
  const value = readUnknown(source, key)
  return typeof value === "string" ? value : undefined
}

export function readNumber(source: unknown, key: string): number | undefined {
  const value = readUnknown(source, key)
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function readRecord(source: unknown, key: string): Record<string, unknown> | undefined {
  return asRecord(readUnknown(source, key))
}

export function readArray(source: unknown, key: string): unknown[] | undefined {
  const value = readUnknown(source, key)
  return Array.isArray(value) ? value : undefined
}
