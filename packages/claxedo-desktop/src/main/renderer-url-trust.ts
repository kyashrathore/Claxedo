type TrustedRendererUrlOptions = {
  devServerUrl?: string
  packagedIndexUrl: string
}

/**
 * RFC 3986 makes a percent-encoded unreserved character the same as the
 * character itself, and the two sides spell it differently: Node's
 * `pathToFileURL` writes `~` as `%7E` while Chromium reports it literally, so
 * an 8.3 path such as `C:\Users\RUNNER~1` matches only once both are decoded.
 * Only unreserved characters are decoded; `%2F` and the rest keep their meaning.
 */
function documentUrl(input: string) {
  const url = new URL(input)
  url.hash = ""
  url.search = ""
  return url.href.replace(/%([0-9A-Fa-f]{2})/g, (escape: string, hex: string) => {
    const character = String.fromCharCode(Number.parseInt(hex, 16))
    return /^[A-Za-z0-9\-._~]$/.test(character) ? character : escape.toUpperCase()
  })
}

/**
 * Trust the configured Vite origin in development because Claxedo's router
 * owns pathname-based workspace/session URLs. The Vite process is the dev
 * document authority; scheme, host, and port must still match exactly.
 * Packaged builds have no dev origin and trust only their index file.
 */
export function isTrustedRendererDocumentUrl(input: string, options: TrustedRendererUrlOptions) {
  try {
    const actual = documentUrl(input)
    if (!options.devServerUrl) return actual === documentUrl(options.packagedIndexUrl)
    return new URL(actual).origin === new URL(options.devServerUrl).origin
  } catch {
    return false
  }
}
