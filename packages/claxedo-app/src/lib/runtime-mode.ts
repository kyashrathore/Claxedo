export function isDemoPath(path: string) {
  return path === "/demo" || path.startsWith("/demo/")
}

export function isDemoMode() {
  if (typeof window === "undefined") return false
  return isDemoPath(window.location.pathname)
}

export function isEmbedMode() {
  if (typeof window === "undefined") return false
  return new URLSearchParams(window.location.search).has("embed")
}

/**
 * Whether the document's own URL backs routing, and is therefore safe to write.
 *
 * The packaged desktop renderer is loaded with `win.loadFile(...)` and routes
 * with `MemoryRouter`, so its URL is never the source of truth — but the address
 * bar is still writable. `history.replaceState(state, "", "/w/<dir>/<session>")`
 * therefore rewrote the window URL to `file:///w/<dir>/<session>`, and the next
 * reload asked Chromium to load that path *as a file*: `net::ERR_FAILED`, which
 * strands the user on a blank `chrome-error://chromewebdata/` page that only
 * relaunching the app recovers.
 *
 * Only an http(s) document can carry route state across a reload, so URL writes
 * are gated on the protocol rather than on a desktop/web flag — a `file://` page
 * cannot round-trip a pushed path no matter which shell is hosting it.
 */
export function urlRoutingEnabled() {
  if (typeof window === "undefined") return false
  return /^https?:$/.test(window.location.protocol)
}
