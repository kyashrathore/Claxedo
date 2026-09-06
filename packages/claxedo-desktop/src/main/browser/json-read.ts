/**
 * Total readers for untyped JSON-ish payloads reaching the main process.
 *
 * The agent-browser subsystem sits on two boundaries that hand TypeScript
 * nothing: CDP (`Debugger.sendCommand` resolves to `unknown`, and the
 * `message` event's `params` is whatever the browser sent) and the HTTP
 * bridge (request bodies are `JSON.parse` output). Both used to declare a
 * hand-written shape per call site and cast the payload to it, which asserts
 * a contract the remote end never promised.
 *
 * These readers are the single place that decision is made: they never throw,
 * never assert, and return `undefined` for anything that is not present in
 * the expected shape. Callers compose them into one parse per payload.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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
  const value = readUnknown(source, key)
  return isRecord(value) ? value : undefined
}

export function readArray(source: unknown, key: string): unknown[] | undefined {
  const value = readUnknown(source, key)
  return Array.isArray(value) ? value : undefined
}
