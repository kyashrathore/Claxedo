import { urlRoutingEnabled } from "./runtime-mode"

/** Document history belongs to HTTP routing; file-backed windows use their router. */
export function writeBrowserRoute(url: string, options: { replace: boolean; notify: boolean }) {
  if (!urlRoutingEnabled()) return
  if (options.replace) window.history.replaceState(window.history.state, "", url)
  else window.history.pushState(null, "", url)
  if (options.notify) window.dispatchEvent(new PopStateEvent("popstate"))
}
