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
    // The server bundle's prebuilt V8 compile cache.
    serverCompileCacheDir: env.CLAXEDO_CHILD_SERVER_COMPILE_CACHE_DIR || undefined,
    dataDir: env.CLAXEDO_DATA_DIR || undefined,
  }
}
