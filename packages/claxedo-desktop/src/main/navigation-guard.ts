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
 * Policy: the app document navigates normally and every other navigation or
 * `window.open` is dropped. The app's live plugins run in this document, so a
 * plugin's `location` or `window.open` must not become a way to send data out;
 * the app's own links leave through the `open-link` IPC instead. Kept free of
 * electron imports so it is directly testable.
 */

/**
 * Schemes the explicit `open-link` IPC hands to the OS. `shell.openExternal`
 * invokes the platform handler for whatever scheme it receives, making an
 * unrestricted call a launch primitive: `file:` opens bundles and executables,
 * and every OS ships its own privileged schemes. An allowlist is the only safe
 * shape here — a denylist loses to the next platform-specific scheme. `claxedo:`
 * is this app's own registered scheme and `vscode:` the editor the workspace
 * opens files in; one more entry is one more program an agent's rendered output
 * can start. Navigation never consults it.
 */
const LINK_SCHEMES = new Set(["http:", "https:", "mailto:", "claxedo:", "vscode:"])

/**
 * The one renderer document every desktop emits and loads.
 *
 * Signed capability is not a second document. A signed-capable release starts
 * from this exact local composition and loads its separately fingerprinted
 * hosted contribution chunk only after Electron main reports a signed account.
 * Keeping the document constant makes the unsigned startup path identical in a
 * self-build and an official release.
 */
export const MAIN_RENDERER_DOCUMENT = "index.local.html"

export function isOpenableLinkUrl(input: string) {
  try {
    return LINK_SCHEMES.has(new URL(input).protocol)
  } catch {
    return false
  }
}

export type NavigationDecision = { action: "allow" } | { action: "block"; url: string }

/**
 * In-window navigation. `isTrusted` is the caller's app-document check
 * (`isTrustedMainRendererUrl`), injected so this stays electron-free.
 */
export function navigationDecision(url: string, isTrusted: (input: string) => boolean): NavigationDecision {
  return isTrusted(url) ? { action: "allow" } : { action: "block", url }
}

/**
 * `window.open` / `target="_blank"`. Never "allow": a new window would inherit
 * this window's webPreferences, preload included.
 */
export function windowOpenDecision(url: string): Exclude<NavigationDecision, { action: "allow" }> {
  return { action: "block", url }
}
