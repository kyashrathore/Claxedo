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
const parent = diagnosticsParent()
const binding = diagnosticsBinding(process.env, Boolean(parent))
const transport = binding && parent
  ? createDiagnosticsChildTransport({ binding, send: parent.send })
  : undefined
parent?.listen((message) => void transport?.onMessage(message))

startServer(startup.port, startup.opencodeUrl, startup.opencodePassword, {
  ...(startup.opencodeEmbedPath ? { opencodeEmbedPath: startup.opencodeEmbedPath } : {}),
  ...(startup.opencodeWorkerPath ? { opencodeWorkerPath: startup.opencodeWorkerPath } : {}),
  ...(transport ? { processObserver: transport.observer } : {}),
})

// Bundle evaluation creates a large temporary object graph. The long-lived
// server does not need it, so release it promptly instead of waiting for
// machine-wide memory pressure to force a major collection.
;(globalThis as typeof globalThis & { gc?: () => void }).gc?.()
setTimeout(() => {
  ;(globalThis as typeof globalThis & { gc?: () => void }).gc?.()
}, 1_000).unref()

function diagnosticsParent() {
  if (typeof process.send === "function") {
    return {
      send: (message: Parameters<NonNullable<typeof process.send>>[0]) => process.send?.(message),
      listen: (listener: (message: unknown) => void) => process.on("message", listener),
    }
  }
  if (!process.parentPort) return
  return {
    send: (message: Parameters<typeof process.parentPort.postMessage>[0]) => process.parentPort.postMessage(message),
    listen: (listener: (message: unknown) => void) => process.parentPort.on("message", (event) => listener(event.data)),
  }
}

function diagnosticsBinding(env: NodeJS.ProcessEnv, connected: boolean): DiagnosticsBinding | undefined {
  const launchId = env.CLAXEDO_DIAGNOSTICS_LAUNCH_ID?.trim()
  const generation = env.CLAXEDO_DIAGNOSTICS_GENERATION?.trim()
  if (!connected || !launchId || !generation) return
  return { pid: process.pid, launchId, generation }
}
