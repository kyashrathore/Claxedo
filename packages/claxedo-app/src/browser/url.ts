const SEARCH_URL = "https://www.google.com/search?q="

export function normalizeAddressBarInput(raw: string): string {
  const input = raw.trim()
  if (!input) return input
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return input
  if (/\s/.test(input)) return `${SEARCH_URL}${encodeURIComponent(input)}`
  const looksLikeUrl = input.includes(".") || /^localhost(:\d+)?/i.test(input) || /^[a-z0-9-]+:\d+/i.test(input)
  if (!looksLikeUrl) return `${SEARCH_URL}${encodeURIComponent(input)}`
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?/i.test(input)) return `http://${input}`
  return `https://${input}`
}

export function sameOrigin(a: string, b: string): boolean {
  if (!URL.canParse(a) || !URL.canParse(b)) return false
  const left = new URL(a)
  const right = new URL(b)
  if (left.origin === "null" || right.origin === "null") return left.href === right.href
  return left.origin === right.origin
}

export function displayHost(url: string): string {
  return URL.canParse(url) ? new URL(url).host || url : url
}

export function visibleUrl(url: string): string {
  return url === "about:blank" ? "" : url
}

const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]

export function isLoopbackPage(url: string): boolean {
  return URL.canParse(url) && LOOPBACK_HOSTS.includes(new URL(url).hostname)
}
