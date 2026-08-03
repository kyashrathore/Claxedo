import { startServer } from "../../claxedo-server/src/deployments/local/server"
import type { DiagnosticsBinding } from "../src/shared/diagnostics-transport"
import { claxedoServerStartup, watchDesktopParent } from "./claxedo-server-startup"
import { createDiagnosticsChildTransport } from "./diagnostics-child-transport"

const startup = claxedoServerStartup(process.env)
const terminate = () => process.kill(process.pid, "SIGTERM")
watchDesktopParent({
  pid: startup.desktopParentPid,
  onOrphaned: terminate,
})
const binding = diagnosticsBinding(process.env)
const transport = binding && process.parentPort
  ? createDiagnosticsChildTransport({ binding, send: (message) => process.parentPort.postMessage(message) })
  : undefined
process.parentPort?.on("message", (event) => {
  void transport?.onMessage(event.data)
})

startServer(startup.port, startup.opencodeUrl, startup.opencodePassword, {
  ...(startup.opencodeEmbedPath ? { opencodeEmbedPath: startup.opencodeEmbedPath } : {}),
  ...(transport ? { processObserver: transport.observer } : {}),
})

// Bundle evaluation creates a large temporary object graph. The long-lived
// server does not need it, so release it promptly instead of waiting for
// machine-wide memory pressure to force a major collection.
;(globalThis as typeof globalThis & { gc?: () => void }).gc?.()
setTimeout(() => {
  ;(globalThis as typeof globalThis & { gc?: () => void }).gc?.()
}, 1_000).unref()

function diagnosticsBinding(env: NodeJS.ProcessEnv): DiagnosticsBinding | undefined {
  const launchId = env.CLAXEDO_DIAGNOSTICS_LAUNCH_ID?.trim()
  const generation = env.CLAXEDO_DIAGNOSTICS_GENERATION?.trim()
  if (!process.parentPort || !launchId || !generation) return
  return { pid: process.pid, launchId, generation }
}
