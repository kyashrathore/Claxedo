export function claxedoServerStartup(env: NodeJS.ProcessEnv) {
  const port = Number(env.CLAXEDO_CHILD_PORT)
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("Claxedo server utility process is missing its startup configuration")
  }
  const desktopParentPid = Number(env.CLAXEDO_DESKTOP_PARENT_PID)
  if (!Number.isInteger(desktopParentPid) || desktopParentPid <= 0) {
    throw new Error("Claxedo server utility process is missing its desktop owner")
  }

  return {
    port,
    desktopParentPid,
    opencodeUrl: env.CLAXEDO_CHILD_OPENCODE_URL || undefined,
    opencodePassword: env.CLAXEDO_CHILD_OPENCODE_PASSWORD || null,
    opencodeEmbedPath: env.CLAXEDO_CHILD_OPENCODE_EMBED_PATH || undefined,
  }
}

export function watchDesktopParent(input: {
  pid: number
  onOrphaned(): void
  intervalMs?: number
  probe?: (pid: number, signal: 0) => void
}) {
  const timer = setInterval(() => {
    try {
      ;(input.probe ?? process.kill)(input.pid, 0)
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") return
      clearInterval(timer)
      input.onOrphaned()
    }
  }, input.intervalMs ?? 250)
  timer.unref()
  return () => clearInterval(timer)
}
