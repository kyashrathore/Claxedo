import { isString } from "./guards"

/**
 * Normalizes caller-supplied input — HTTP query strings, process env, worker
 * bindings — and returns the TRIMMED value.
 */
export function requiredText(value: unknown, name: string): string {
  const trimmed = isString(value) ? value.trim() : ""
  if (trimmed.length === 0) throw new Error(`${name} is required`)
  return trimmed
}

/**
 * Asserts an identity string is non-empty AND already trimmed, then returns it
 * UNCHANGED. It never trims for the caller: these values are persisted and
 * interpolated into SQL and URLs, so a silently-trimmed value would be a
 * different identity than the one validated.
 */
export function requireCanonicalString(
  value: string,
  field: string,
  onInvalid: (message: string) => Error = (message) => new Error(message),
): string {
  if (!value || value.trim() !== value) {
    throw onInvalid(`${field} must be a non-empty trimmed string`)
  }
  return value
}

/**
 * Requires the caller to pass the exact origin string, optionally with ONE
 * trailing slash — which rejects paths, uppercase hosts, an explicit `:443`,
 * credentials, wildcards and surrounding whitespace. Returns the normalized
 * `url.origin`, never a URL object.
 */
export function exactHttpsOrigin(
  value: string | undefined,
  name: string,
  options?: { allowPort?: boolean; error?: (message: string) => Error },
): string {
  const fail = options?.error ?? ((message: string) => new Error(message))
  const trimmed = value?.trim() ?? ""
  if (trimmed.length === 0) throw fail(`${name} is required`)

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw fail(`${name} must be an exact https origin`)
  }

  const invalid =
    url.protocol !== "https:" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hostname.includes("*") ||
    (options?.allowPort === false && url.port !== "") ||
    (url.origin !== trimmed && `${url.origin}/` !== trimmed)
  if (invalid) throw fail(`${name} must be an exact https origin`)

  return url.origin
}

export interface TextValidators {
  requireText: (value: unknown, name: string, max?: number) => string
  optionalText: (value: unknown, name: string, max?: number) => string | undefined
}

/**
 * Per-module factory bound to that authority's error constructor, so each
 * adapter keeps its own error taxonomy while sharing one predicate and one
 * message. Length is measured on the TRIMMED value, and the trimmed value is
 * what callers bind to SQL.
 */
export function createRequireText(fail: (message: string) => Error): TextValidators {
  function requireText(value: unknown, name: string, max = 512): string {
    if (!isString(value)) throw fail(`${name} must be a string`)
    const trimmed = value.trim()
    if (trimmed.length === 0 || trimmed.length > max) {
      throw fail(`${name} must be a non-empty string of at most ${max} characters`)
    }
    return trimmed
  }
  return {
    requireText,
    optionalText: (value, name, max) => (value === undefined ? undefined : requireText(value, name, max)),
  }
}
