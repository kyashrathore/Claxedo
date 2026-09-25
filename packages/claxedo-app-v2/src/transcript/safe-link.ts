export type InternalLink = { kind: "internal"; href: string }
export type ExternalLink = { kind: "external"; href: string }
export type SafeLink = InternalLink | ExternalLink

const EXTERNAL_SCHEMES = new Set(["https", "http", "file", "vscode", "claxedo", "mailto"])

function isInternalReference(href: string): boolean {
  if (href.startsWith("#") || href.startsWith("?") || href.startsWith("./") || href.startsWith("../")) {
    return true
  }
  return href.startsWith("/") && href[1] !== "/" && href[1] !== "\\"
}

export function parseSafeLink(value: string | undefined | null): SafeLink | undefined {
  const href = value?.trim()
  if (!href) return undefined
  if (isInternalReference(href)) return { kind: "internal", href }
  if (URL.canParse(href) && EXTERNAL_SCHEMES.has(new URL(href).protocol.slice(0, -1))) return { kind: "external", href }
  return undefined
}

export function safeLinkHref(value: string | undefined | null): string | undefined {
  return parseSafeLink(value)?.href
}
