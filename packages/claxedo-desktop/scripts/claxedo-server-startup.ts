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
    // The server bundle's prebuilt V8 compile cache. This function owns the
    // complete desktop child-process startup contract.
    serverCompileCacheDir: env.CLAXEDO_CHILD_SERVER_COMPILE_CACHE_DIR || undefined,
    dataDir: env.CLAXEDO_DATA_DIR || undefined,
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
