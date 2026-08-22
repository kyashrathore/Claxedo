// The desktop-local product, not the mixed self-hosted composition. This is
// the line that keeps an unsigned desktop from closing over the hosted control
// plane: `@claxedo/local-server` cannot reach Documents, Connections, Channels,
// WorkGraph, a workspace authority, or cloud provisioning, and its own closure
// test asserts so.
import { startLocalServer } from "@claxedo/local-server/self-hosted-execution"
import type { DiagnosticsBinding } from "../src/shared/diagnostics-transport"
import { claxedoServerStartup, watchDesktopParent } from "./claxedo-server-startup"
import { createDiagnosticsChildTransport } from "./diagnostics-child-transport"
import { claxedoServerReadyMessage } from "../src/shared/claxedo-server-lifecycle"
import { recordStartupClock } from "../src/shared/startup-clock-probe"

// The V8 compile cache is already enabled and already seeded by the time this
// module is COMPILED, let alone evaluated: `claxedo-server-boot.ts` is the
// bundle's entry and reaches this file through a dynamic import. It cannot be
// done from here — a graph is compiled before its own bodies run, so a cache
// switched on in this body would arrive 9.11 MB too late.
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

const server = startLocalServer({
  port: startup.port,
  ...(startup.opencodeUrl ? { opencodeUrl: startup.opencodeUrl } : {}),
  opencodePassword: startup.opencodePassword,
  ...(startup.opencodeEmbedPath ? { opencodeEmbedPath: startup.opencodeEmbedPath } : {}),
  ...(transport ? { processObserver: transport.observer } : {}),
})
void server.ready.then(() => {
  // The IPC send goes FIRST and unconditionally: the probe below is a
  // diagnostic, and a diagnostic that can delay the message main waits on to
  // publish the server URL would be measuring a cost it created.
  parent?.send(claxedoServerReadyMessage(startup.port))
  recordStartupClock("server-listening", { port: startup.port })
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
