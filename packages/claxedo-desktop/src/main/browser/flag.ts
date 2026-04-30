/**
 * Main-process feature flag for the agentic browser tab.
 *
 * Returns true iff `CLAXEDO_ENABLE_BROWSER_TAB=1` is set in the process
 * environment. Mirrors the split-flag decision in the plan: the renderer has
 * its own build-time gate (`VITE_CLAXEDO_ENABLE_BROWSER_TAB`). Both must be
 * co-set for the feature to be end-to-end reachable.
 */
export function isBrowserTabEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAXEDO_ENABLE_BROWSER_TAB === "1"
}
