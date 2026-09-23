import { urlRoutingEnabled } from "./runtime-mode"

let documentRouting = true

/** Set by `AppInterface` from the router actually mounted in this window. */
export function configureBrowserHistory(enabled: boolean) {
  documentRouting = enabled
}

/**
 * Document history belongs to HTTP routing; file-backed windows use their own
 * router. `urlRoutingEnabled()` reads the deployment, which still says HTTP for
 * a desktop dev window served over http — and that window runs a MemoryRouter,
 * so writing here changed the URL it would reload from.
 */
export function writeBrowserRoute(url: string, options: { replace: boolean; notify: boolean }) {
  if (!documentRouting || !urlRoutingEnabled()) return
  if (options.replace) window.history.replaceState(window.history.state, "", url)
  else window.history.pushState(null, "", url)
  if (options.notify) window.dispatchEvent(new PopStateEvent("popstate"))
}
