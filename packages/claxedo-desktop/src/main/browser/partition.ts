/**
 * Agent-browser session partition setup.
 *
 * All agent-browser `<webview>` guests share one Electron `session` keyed by
 * `persist:agent-browser`. That session is:
 *   - isolated from the host-UI session (so cookies / local storage cannot bleed
 *     between the claxedo UI and the embedded pages)
 *   - locked down with default-deny permission handlers (notifications, geo,
 *     media, midi, clipboard-read, persistent-storage, fullscreen)
 *   - blocked from opening new windows (`setWindowOpenHandler` denies)
 *   - blocked from navigating to non-http(s) URLs (`will-navigate`)
 *   - blocked from downloads (`will-download`)
 *
 * This is called once at main-process startup when the browser capability is
 * enabled. Running the configuration more than once
 * is a no-op because the permission / window-open / navigation handlers replace
 * any prior registration.
 */

import { session as sessionModule } from "electron"
import type { Session, WebContents } from "electron"

import { AGENT_BROWSER_PARTITION } from "./will-attach-webview"

const DENIED_PERMISSIONS = new Set([
  "notifications",
  "geolocation",
  "media",
  "midi",
  "midiSysex",
  "clipboard-read",
  "persistent-storage",
  "fullscreen",
  "pointerLock",
  "openExternal",
])

let configured = false

/**
 * Configure the agent-browser session partition. Idempotent.
 */
export function configureAgentBrowserPartition(): Session {
  const session = sessionModule.fromPartition(AGENT_BROWSER_PARTITION)

  if (configured) return session
  configured = true

  session.setPermissionRequestHandler((_wc: WebContents | null, permission: string, callback) => {
    if (DENIED_PERMISSIONS.has(permission)) {
      callback(false)
      return
    }
    // Default-deny everything else we did not explicitly allow. Future
    // allowlisted permissions go here.
    callback(false)
  })

  session.setPermissionCheckHandler((_wc, permission) => {
    if (DENIED_PERMISSIONS.has(permission)) return false
    return false
  })

  // Block downloads initiated by guests in this partition. (Window-open is
  // denied per-webContents by `installAgentBrowserNavigationGuards`.)
  session.on("will-download", (event) => {
    event.preventDefault()
  })

  return session
}

/**
 * Wire per-webContents navigation guards. Must be called for each guest
 * `webContents` belonging to the agent-browser partition (typically from the
 * `web-contents-created` hook in the main process). Allows http/https only;
 * blocks new windows; denies downloads.
 */
export function installAgentBrowserNavigationGuards(wc: WebContents): void {
  wc.on("will-navigate", (event, urlString) => {
    if (!isAllowedNavigationUrl(urlString)) {
      event.preventDefault()
    }
  })

  wc.setWindowOpenHandler(() => ({ action: "deny" as const }))
}

export function isAllowedNavigationUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}
