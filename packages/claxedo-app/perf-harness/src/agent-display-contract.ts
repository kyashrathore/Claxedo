export const AGENT_APP_WINDOW = { width: 1440, height: 900 } as const

/** Content viewport produced by the fixed app window and the platform's owned chrome. */
export function agentAppViewport(platform: NodeJS.Platform = process.platform) {
  const override = process.env.CLAXEDO_BENCH_VIEWPORT?.trim()
  if (override) {
    const match = /^(\d+)x(\d+)$/u.exec(override)
    if (!match) throw new Error(`CLAXEDO_BENCH_VIEWPORT must be WIDTHxHEIGHT, got ${override}`)
    return { width: Number(match[1]), height: Number(match[2]) }
  }
  return {
    width: AGENT_APP_WINDOW.width,
    height: platform === "darwin" ? AGENT_APP_WINDOW.height - 25 : AGENT_APP_WINDOW.height,
  }
}
