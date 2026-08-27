import { CLAXEDO_DAEMON_PROTOCOL } from "../src/main/server-daemon-discovery"

export function claxedoServerStartup(env: NodeJS.ProcessEnv) {
  const port = Number(env.CLAXEDO_CHILD_PORT)
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("Claxedo server utility process is missing its startup configuration")
  }
  const daemonProtocol = Number(env.CLAXEDO_DAEMON_PROTOCOL)
  const daemonToken = env.CLAXEDO_DAEMON_TOKEN?.trim()
  const daemonGeneration = env.CLAXEDO_DAEMON_GENERATION?.trim()
  const daemonDiscoveryPath = env.CLAXEDO_DAEMON_DISCOVERY_PATH?.trim()
  if (
    daemonProtocol !== CLAXEDO_DAEMON_PROTOCOL ||
    !daemonToken ||
    !daemonGeneration ||
    !daemonDiscoveryPath
  ) {
    throw new Error("Claxedo server utility process is missing its daemon identity")
  }

  return {
    port,
    daemonProtocol: CLAXEDO_DAEMON_PROTOCOL,
    daemonToken,
    daemonGeneration,
    daemonDiscoveryPath,
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
