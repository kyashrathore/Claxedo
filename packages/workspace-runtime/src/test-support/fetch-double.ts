/**
 * Test-only helpers for standing in for the global `fetch`.
 *
 * Production code here calls the global `fetch` directly, so tests substitute
 * `globalThis.fetch`. The obstacle is purely structural: `typeof fetch` carries
 * statics (`preconnect`, and Bun adds its own) that no test double supplies, so
 * `mock(async () => new Response()) as typeof fetch` is not a legal assertion —
 * TypeScript rightly reports the two types do not overlap.
 *
 * The honest fix is to say once, in one place, "this handler is the only part
 * of `fetch` under test" and attach the statics, rather than repeating
 * `as unknown as typeof fetch` at ~40 call sites. Widening the production
 * signature is not an option: these functions really do call the global.
 */

/** The part of `fetch` a double actually implements. */
export type FetchHandler = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/**
 * Types a handler as the global `fetch`, supplying the statics it lacks.
 *
 * `preconnect` is a no-op: it is a hint with no observable result, and nothing
 * under test calls it. If a caller ever does, it should be given real behavior
 * here rather than at the call site.
 */
export function fetchDouble(handler: FetchHandler): typeof fetch {
  const impl = ((input: string | URL | Request, init?: RequestInit) =>
    handler(input, init)) as unknown as typeof fetch
  Object.defineProperty(impl, "preconnect", {
    value: () => {},
    writable: true,
    configurable: true,
  })
  return impl
}

/**
 * The URL a `fetch` double was called with, as text.
 *
 * `String(input)` looks equivalent but is not: a `Request` stringifies to
 * "[object Request]", so a double that happens to be handed one starts
 * asserting against a placeholder instead of a URL. Reading `.url` is the only
 * form that covers all three shapes `fetch` accepts.
 */
export function fetchUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input
  return input instanceof URL ? input.href : input.url
}

/**
 * A `fetch` double's request body as text.
 *
 * Every double in this package sends JSON as a string, so anything else is a
 * test bug rather than a body to coerce: `String(body)` on a `Blob` or a
 * `FormData` yields "[object Blob]", which then fails a JSON parse several
 * assertions later with no hint of the cause.
 */
export function fetchBodyText(body: BodyInit | null | undefined): string {
  if (body === null || body === undefined) return ""
  if (typeof body === "string") return body
  throw new Error("fetch double received a non-string body; it records text bodies only")
}

/** {@link fetchBodyText}, parsed. `undefined` when there was no body. */
export function fetchBodyJson(body: BodyInit | null | undefined): unknown {
  const text = fetchBodyText(body)
  return text ? JSON.parse(text) : undefined
}
