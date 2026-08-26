// LANE-LOCAL MEASUREMENT AID (lane-reconcile) — NOT part of the lane's patch.
//
// The contract this file owns is the CONTENT viewport: every measured arm must
// render into exactly 1440x900 CSS pixels. `--claxedo-window-size` sets the
// window's OUTER size, and on this Linux host the packaged window reserves 27px
// of chrome inside it (verified directly: outer 1440x900 -> innerWidth 1440,
// innerHeight 873, with and without a window manager, and on two independently
// built packages). Requesting 900 outer therefore yields an 873-tall content
// viewport and `launchPackagedClaxedo`'s fixed-viewport gate never passes.
//
// The window request is widened by that measured chrome allowance so the
// CONTENT is the contracted 1440x900. The gate below still verifies the real
// innerWidth/innerHeight — it is not relaxed — and both arms of this lane are
// measured at the identical content size.
const LINUX_WINDOW_CHROME_HEIGHT = 27

export const AGENT_APP_VIEWPORT = { width: 1440, height: 900 } as const

export const AGENT_APP_WINDOW = {
  width: AGENT_APP_VIEWPORT.width,
  height: AGENT_APP_VIEWPORT.height + (process.platform === "linux" ? LINUX_WINDOW_CHROME_HEIGHT : 0),
} as const

/** Content viewport produced by the fixed app window and the platform's owned chrome. */
export function agentAppViewport(platform: NodeJS.Platform = process.platform) {
  return {
    width: AGENT_APP_VIEWPORT.width,
    height: platform === "darwin" ? AGENT_APP_VIEWPORT.height - 25 : AGENT_APP_VIEWPORT.height,
  }
}
