/**
 * A caller-supplied href checked against the card-link scheme policy.
 * `internal` stays on the host's own navigation surface — a root-relative
 * route, fragment, query, or dot-relative path. `external` is an absolute URL
 * on a scheme a host can open. Anything else — `javascript:`, `data:`,
 * `vbscript:`, a protocol-relative `//host`, an unparseable string — never
 * becomes a SafeLink.
 */
export type InternalLink = { kind: "internal"; href: string }
export type ExternalLink = { kind: "external"; href: string }
export type SafeLink = InternalLink | ExternalLink

/**
 * Absolute schemes a host can hand to a browser or OS open path — the same
 * set `transcriptLinkPrefixes` autolinks in transcript text. Duplicated
 * rather than imported so card primitives do not pull the markdown pipeline
 * into their module graph.
 */
const EXTERNAL_SCHEMES = new Set(["https", "http", "file", "vscode", "claxedo", "mailto"])

function isInternalReference(href: string): boolean {
  if (href.startsWith("#") || href.startsWith("?") || href.startsWith("./") || href.startsWith("../")) {
    return true
  }
  // A second separator — "//host", "/\host" — rebases the URL onto that host
  // under WHATWG parsing, so only a lone leading "/" is a root path.
  return href.startsWith("/") && href[1] !== "/" && href[1] !== "\\"
}

export function parseSafeLink(value: string | undefined | null): SafeLink | undefined {
  const href = value?.trim()
  if (!href) return undefined
  if (isInternalReference(href)) return { kind: "internal", href }
  try {
    const url = new URL(href)
    if (EXTERNAL_SCHEMES.has(url.protocol.slice(0, -1))) return { kind: "external", href }
  } catch {
    // Not an absolute URL: a bare relative path or prose has no card-link form.
  }
  return undefined
}

export function safeLinkHref(value: string | undefined | null): string | undefined {
  return parseSafeLink(value)?.href
}
