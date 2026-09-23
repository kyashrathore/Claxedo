/**
 * Schemes a link opener may hand to a new browsing context or the OS scheme
 * registry. `window.open` navigates to whatever it receives — `javascript:`
 * executes in this document's origin and `file:`/`data:` load
 * attacker-controlled content — so the list is closed rather than denied. It
 * mirrors the desktop's open-link gate (claxedo-desktop
 * `main/navigation-guard.ts`): transcript and workspace links deliberately
 * route this app's own `claxedo:` scheme and the `vscode:` editor protocol
 * through `platform.openLink`.
 */
const OPENABLE_SCHEMES: readonly string[] = ["http:", "https:", "mailto:", "claxedo:", "vscode:"]

/**
 * The absolute href a link opener may navigate to, or null when the scheme is
 * not one a new context may carry. Relative input resolves against the current
 * document, so an in-app path keeps working while `javascript:` — which parses
 * to its own scheme under any base — is refused.
 */
export function openableLinkHref(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url, window.location.href)
  } catch {
    return null
  }
  return OPENABLE_SCHEMES.includes(parsed.protocol) ? parsed.href : null
}

/**
 * The web `platform.openLink`: opens `url` in a new browsing context detached
 * from this document. Returns whether anything was opened.
 */
export function openLink(url: string): boolean {
  const href = openableLinkHref(url)
  if (!href) return false
  window.open(href, "_blank", "noopener,noreferrer")
  return true
}
