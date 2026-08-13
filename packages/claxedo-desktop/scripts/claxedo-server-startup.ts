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
    // Prebuilt V8 compile cache shipped beside the engine artifact, and the
    // writable profile directory its runtime copy is seeded into. Both are
    // declared here rather than read from `process.env` at the use site: this
    // function is the one place that knows what the desktop hands over, and an
    // option consumed but not declared is exactly how the engine worker path
    // was silently dropped once already.
    opencodeCompileCacheDir: env.CLAXEDO_CHILD_OPENCODE_COMPILE_CACHE_DIR || undefined,
    // The same, for this bundle's OWN static closure. It is a second shipped
    // set rather than more entries in the engine's, because the two are
    // generated from different artifacts at different points in the build and
    // their manifests are relative to different roots.
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
