import { renewEmbeddedWorkspaceRuntimeConfigs } from "./embedded-workspace-runtime"

/** How often the renewal check runs; what it renews is decided from each placeholder's expiry. */
const RENEWAL_CHECK_INTERVAL_MS = 30_000

/** Drive {@link renewEmbeddedWorkspaceRuntimeConfigs} off a timer. Returns the stop. */
export function startEmbeddedWorkspaceRuntimeConfigRenewal(options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now
  let lastCheck = now()
  const timer = setInterval(() => {
    const at = now()
    const slept = at - lastCheck > RENEWAL_CHECK_INTERVAL_MS * 2
    lastCheck = at
    void renewEmbeddedWorkspaceRuntimeConfigs({ at, all: slept })
  }, RENEWAL_CHECK_INTERVAL_MS)
  timer.unref()
  return () => clearInterval(timer)
}
