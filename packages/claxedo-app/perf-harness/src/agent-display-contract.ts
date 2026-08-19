export const AGENT_APP_WINDOW = { width: 1440, height: 900 } as const

/** Content viewport produced by the fixed app window and the platform's owned chrome. */
export function agentAppViewport(platform: NodeJS.Platform = process.platform) {
  return {
    width: AGENT_APP_WINDOW.width,
    height: platform === "darwin" ? AGENT_APP_WINDOW.height - 25 : AGENT_APP_WINDOW.height,
  }
}
