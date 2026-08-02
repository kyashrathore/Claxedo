/**
 * Navigation policy for the MAIN application window.
 *
 * Why this exists at all: the preload calls
 * `contextBridge.exposeInMainWorld("api", ...)` and runs on EVERY document its
 * webContents loads, not only ours. A top-level navigation away from the app
 * document therefore hands the destination origin the entire IPC bridge —
 * including `openPath(path, app)`, which the main process services with
 * `execFile(app, [path])`. That is arbitrary command execution.
 *
 * It is reachable by a single click: `marked` renders an ordinary
 * `[text](https://…)` link with no `target`, so it navigates THIS window rather
 * than opening a new one, and rendered agent output is attacker-influenceable
 * via prompt injection (a malicious repo file, a fetched web page). The
 * `window.open` / `target="_blank"` path is the same problem wearing a hat: with
 * no handler installed Electron spawns a BrowserWindow that inherits these
 * webPreferences.
 *
 * Policy: the app document navigates normally, safe external URLs go to the OS
 * browser (what a user clicking a link actually means), everything else is
 * dropped. Kept free of electron imports so it is directly testable.
 */

/**
 * Schemes we are willing to hand to the OS. `shell.openExternal` invokes the
 * platform handler for whatever scheme it receives, making an unrestricted call
 * a launch primitive: `file:` opens bundles and executables, and every OS ships
 * its own privileged schemes. An allowlist is the only safe shape here — a
 * denylist loses to the next platform-specific scheme.
 */
const EXTERNAL_SCHEMES = new Set(["http:", "https:", "mailto:"])

export function isSafeExternalUrl(input: string) {
  try {
    return EXTERNAL_SCHEMES.has(new URL(input).protocol)
  } catch {
    return false
  }
}

export type NavigationDecision =
  /** The app document itself — let it through. */
  | { action: "allow" }
  /** Not ours, but safe to hand to the OS browser. */
  | { action: "external"; url: string }
  /** Neither — drop it. */
  | { action: "block"; url: string }

/**
 * In-window navigation. `isTrusted` is the caller's app-document check
 * (`isTrustedMainRendererUrl`), injected so this stays electron-free.
 */
export function navigationDecision(url: string, isTrusted: (input: string) => boolean): NavigationDecision {
  if (isTrusted(url)) return { action: "allow" }
  return isSafeExternalUrl(url) ? { action: "external", url } : { action: "block", url }
}

/**
 * `window.open` / `target="_blank"`. Never "allow": a new window would inherit
 * this window's webPreferences, preload included, so even a trusted-looking URL
 * gets routed rather than granted a bridge-bearing window of its own.
 */
export function windowOpenDecision(url: string): Exclude<NavigationDecision, { action: "allow" }> {
  return isSafeExternalUrl(url) ? { action: "external", url } : { action: "block", url }
}
