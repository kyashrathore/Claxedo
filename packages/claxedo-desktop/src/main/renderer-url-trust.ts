type TrustedRendererUrlOptions = {
  devServerUrl?: string
  packagedIndexUrl: string
}

function documentUrl(input: string) {
  const url = new URL(input)
  url.hash = ""
  url.search = ""
  return url.href
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
