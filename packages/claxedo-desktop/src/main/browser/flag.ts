/**
 * Main-process feature flag for the in-app browser tab.
 *
 * Browser tabs are a standard desktop capability. The runtime flag remains as
 * an emergency/diagnostic opt-out; set `CLAXEDO_ENABLE_BROWSER_TAB=0` before
 * launch to disable the webview.
 */
export function isBrowserTabEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAXEDO_ENABLE_BROWSER_TAB !== "0"
}
