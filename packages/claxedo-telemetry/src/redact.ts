/**
 * Scrubbing for anything a span carries out of the process.
 *
 * Attribute values and exception text are built from error messages, which
 * routinely embed the URL that failed — userinfo credentials, query tokens —
 * or the upstream body that was rejected. A collector is a third party to
 * that data: anything shaped like a credential is replaced before the span
 * leaves, and every string is capped so one pathological error cannot fill
 * a batch. The patterns are idempotent, so a span scrubbed at production is
 * untouched by the second pass at encode.
 */

import type { AttributeValue, FinishedSpan } from "./span"

/** Longest text kept in a single value; longer strings are cut. */
const MAX_TEXT_LENGTH = 512

/** Most attributes kept on a span or on one of its events; extras never reach the sink. */
export const MAX_ATTRIBUTES = 128

/** Most events kept on a span. */
export const MAX_EVENTS = 128

/** Longest attribute key kept — a longer key is dropped, not truncated, because truncation could merge two keys into one. */
const MAX_ATTRIBUTE_KEY_LENGTH = 128

const CREDENTIAL_PATTERNS: readonly [RegExp, string][] = [
  // URL userinfo: `scheme://user:password@host`
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/"'@]+(?::[^\s/"'@]*)?@/gi, "$1[redacted]@"],
  // Authorization schemes: `Bearer eyJ…`, `Basic dXN…`
  [/\b(bearer|basic|digest)\s+[^\s"',;()[\]{}<>]+/gi, "$1 [redacted]"],
  // `key=value` and `"key": "value"` secrets in query strings, headers and bodies
  [
    /(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret|password|passwd|token|session|credential|sig(?:nature)?|authorization)(["']?\s*[=:]\s*["']?)[^\s&"',}[\]();<>]+/gi,
    "$1$2[redacted]",
  ],
]

/** Replace credential-shaped text and bound the length. Idempotent. */
export function redactText(text: string): string {
  let redacted = text
  for (const [pattern, replacement] of CREDENTIAL_PATTERNS) redacted = redacted.replace(pattern, replacement)
  return redacted.length > MAX_TEXT_LENGTH ? `${redacted.slice(0, MAX_TEXT_LENGTH)}…` : redacted
}

/**
 * Keep only declared attributes and scrub string values.
 *
 * `allowed` absent keeps every key — redaction still applies, because an
 * allowed attribute can still carry a credential-bearing URL.
 */
export function sanitizeAttributes(
  attributes: Record<string, AttributeValue | undefined>,
  allowed?: ReadonlySet<string>,
): Record<string, AttributeValue | undefined> {
  // Null prototype: a `__proto__` attribute key is data, not a prototype write.
  const clean: Record<string, AttributeValue | undefined> = Object.create(null)
  let kept = 0
  for (const [key, value] of Object.entries(attributes)) {
    if (kept >= MAX_ATTRIBUTES) break
    if (key.length > MAX_ATTRIBUTE_KEY_LENGTH) continue
    if (allowed && !allowed.has(key)) continue
    clean[key] = typeof value === "string" ? redactText(value) : value
    kept += 1
  }
  return clean
}

/**
 * A finished span safe to hand to any sink or encoder: names, attributes,
 * status message and event payloads scrubbed, undeclared keys dropped.
 */
export function sanitizeSpan(span: FinishedSpan, allowed?: ReadonlySet<string>): FinishedSpan {
  return {
    ...span,
    name: redactText(span.name),
    attributes: sanitizeAttributes(span.attributes, allowed),
    ...(span.statusMessage !== undefined ? { statusMessage: redactText(span.statusMessage) } : {}),
    events: span.events.slice(0, MAX_EVENTS).map((event) => ({
      ...event,
      name: redactText(event.name),
      ...(event.attributes ? { attributes: sanitizeAttributes(event.attributes, allowed) } : {}),
    })),
  }
}
