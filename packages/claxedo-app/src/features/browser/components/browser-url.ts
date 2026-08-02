/**
 * Normalize an address-bar input into a navigable URL, matching typical
 * browser behavior:
 *  - `https://example.com/x` -> passthrough
 *  - `http://localhost:3000` -> passthrough
 *  - `example.com`, `x.com`, `localhost:3000` -> prepend a scheme
 *  - `how to bake` (no dot, has space) -> Google search
 *  - `/absolute` or `127.0.0.1` -> prepend `http://` for localhost, else search
 * Anything else that looks URL-ish (no space, has dot or colon) gets `https://`.
 */
export function normalizeAddressBarInput(raw: string): string {
  const s = raw.trim()
  if (!s) return s
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s
  if (/\s/.test(s)) {
    return `https://www.google.com/search?q=${encodeURIComponent(s)}`
  }
  const looksLikeUrl = s.includes(".") || /^localhost(:\d+)?/i.test(s) || /^[a-z0-9-]+:\d+/i.test(s)
  if (looksLikeUrl) {
    if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?/i.test(s)) return `http://${s}`
    return `https://${s}`
  }
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`
}
