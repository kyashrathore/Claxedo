/**
 * The URL a `fetch` input addresses, as a string.
 *
 * `fetch` accepts `string | URL | Request`, so `String(input)` silently yields
 * `"[object Object]"` for the `Request` arm. Every caller that wants the target
 * URL of a fetch call — production interceptors and test fetch doubles alike —
 * goes through here instead of restating the three-way narrowing.
 */
export function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  return input.url
}

/** Normalize a URL: map 127.0.0.1 → localhost, strip trailing slashes. */
export function scopeUrl(url: string) {
  try {
    const next = new URL(url)
    if (next.hostname === "127.0.0.1") next.hostname = "localhost"
    return next.toString().replace(/\/+$/, "")
  } catch {
    return url
      .trim()
      .replace(/^http:\/\/127\.0\.0\.1\b/i, "http://localhost")
      .replace(/^https:\/\/127\.0\.0\.1\b/i, "https://localhost")
      .replace(/\/+$/, "")
  }
}
