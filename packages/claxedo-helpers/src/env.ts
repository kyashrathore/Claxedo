import { isRecord, isString } from "./guards"
import { parsePositiveInteger } from "./number"

/**
 * Reads an INJECTED env bag, never `process.env` — that is what makes these
 * testable and keeps the module valid on workerd, where the bag is a binding
 * object. "", "   " and a missing key are all indistinguishable to the caller.
 */
export function envText(env: Record<string, string | undefined>, key: string): string | undefined {
  const raw = env[key]
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Keeps only the own enumerable entries whose value is a string, dropping
 * bindings, numbers, null and objects. `Record<string, string>` is assignable
 * to the `Record<string, string | undefined>` every call site declares.
 */
export function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (isString(entry)) out[key] = entry
  }
  return out
}

/**
 * Fail-closed reader built on the lenient parser. Missing or blank falls back
 * when a fallback is supplied; present-but-invalid ALWAYS throws and never
 * falls back — the lenient core cannot tell missing from invalid, so the
 * wrapper re-checks the raw value itself.
 *
 * The error is supplied by the caller so each composition keeps its own
 * taxonomy.
 */
export function positiveIntegerEnv(
  env: Record<string, string | undefined>,
  key: string,
  options?: { fallback?: number; error?: (key: string) => Error },
): number {
  const fail = options?.error ?? ((name: string) => new Error(`${name} must be a positive integer`))
  const raw = env[key]?.trim()
  if (!raw) {
    if (options?.fallback !== undefined) return options.fallback
    throw fail(key)
  }
  const parsed = parsePositiveInteger(raw)
  if (parsed === undefined) throw fail(key)
  return parsed
}
