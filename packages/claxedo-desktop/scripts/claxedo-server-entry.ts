// The desktop-local product, not the mixed self-hosted composition. This is
// the line that keeps an unsigned desktop from closing over the hosted control
// plane: `@claxedo/local-server` cannot reach Documents, Connections, Channels,
// a workspace authority, or cloud provisioning, and its own closure test
// asserts so.
import { createLocalDaemonLifecycle, startLocalServer } from "@claxedo/local-server/self-hosted-execution"
import type { DiagnosticsBinding } from "../src/shared/diagnostics-transport"
import { claxedoServerStartup } from "./claxedo-server-startup"
import { createDiagnosticsChildTransport } from "./diagnostics-child-transport"
import { claxedoServerReadyMessage } from "../src/shared/claxedo-server-lifecycle"
import { recordStartupClock } from "../src/shared/startup-clock-probe"
import {
  CLAXEDO_DAEMON_SERVICE,
  clearClaxedoDaemonDiscovery,
  writeClaxedoDaemonDiscovery,
  type ClaxedoDaemonDiscovery,
} from "../src/main/server-daemon-discovery"

// The V8 compile cache is already enabled and already seeded by the time this
// module is COMPILED, let alone evaluated: `claxedo-server-boot.ts` is the
// bundle's entry and reaches this file through a dynamic import. It cannot be
// done from here — a graph is compiled before its own bodies run, so a cache
// switched on in this body would arrive 9.11 MB too late.
const startup = claxedoServerStartup(process.env)
const parent = diagnosticsParent()
const binding = diagnosticsBinding(process.env, Boolean(parent))
const transport = binding && parent
  ? createDiagnosticsChildTransport({ binding, send: parent.send })
  : undefined
parent?.listen((message) => void transport?.onMessage(message))

let requestIdleStop = () => {}
const lifecycle = createLocalDaemonLifecycle({
  onIdle: () => requestIdleStop(),
  ...positiveDuration("CLAXEDO_DAEMON_LEASE_TTL_MS", "leaseTtlMs"),
  ...positiveDuration("CLAXEDO_DAEMON_IDLE_GRACE_MS", "idleGraceMs"),
  ...positiveDuration("CLAXEDO_DAEMON_POLL_INTERVAL_MS", "pollIntervalMs"),
})
const server = startLocalServer({
  port: startup.port,
  daemon: {
    identity: {
      token: startup.daemonToken,
      protocol: startup.daemonProtocol,
      generation: startup.daemonGeneration,
      pid: process.pid,
    },
    lifecycle,
  },
  ...(startup.opencodeUrl ? { opencodeUrl: startup.opencodeUrl } : {}),
  opencodePassword: startup.opencodePassword,
  ...(startup.opencodeEmbedPath ? { opencodeEmbedPath: startup.opencodeEmbedPath } : {}),
  ...(transport ? { processObserver: transport.observer } : {}),
})
const discovery: ClaxedoDaemonDiscovery = {
  service: CLAXEDO_DAEMON_SERVICE,
  protocol: startup.daemonProtocol,
  generation: startup.daemonGeneration,
  token: startup.daemonToken,
  pid: process.pid,
  port: startup.port,
  startedAt: new Date().toISOString(),
}
const clearDiscovery = () => clearClaxedoDaemonDiscovery(startup.daemonDiscoveryPath, discovery)
process.once("exit", clearDiscovery)

let stopping = false
const stop = () => {
  if (stopping) return
  stopping = true
  void server.stop().finally(() => {
    clearDiscovery()
    process.exit(0)
  })
}
requestIdleStop = stop
process.once("SIGTERM", stop)
process.once("SIGINT", stop)

void server.ready.then(() => {
  writeClaxedoDaemonDiscovery(startup.daemonDiscoveryPath, discovery)
  // The IPC send goes FIRST and unconditionally: the probe below is a
  // diagnostic, and a diagnostic that can delay the message main waits on to
  // publish the server URL would be measuring a cost it created.
  parent?.send(claxedoServerReadyMessage(startup.port))
  recordStartupClock("server-listening", { port: startup.port })
  lifecycle.start()
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
    let connected = process.connected
    process.once("disconnect", () => {
      connected = false
    })
    return {
      send: (message: Parameters<NonNullable<typeof process.send>>[0]) => {
        if (!connected || !process.connected || typeof process.send !== "function") return
        try {
          // Supplying a callback keeps a close racing this send from becoming
          // an unhandled process-level error. Diagnostics are optional once
          // Electron has released the daemon; PTYs and harnesses are not.
          process.send(message, undefined, undefined, (error) => {
            if (error && "code" in error && error.code === "ERR_IPC_CHANNEL_CLOSED") connected = false
          })
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ERR_IPC_CHANNEL_CLOSED") {
            connected = false
            return
          }
          throw error
        }
      },
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

function positiveDuration<Key extends "leaseTtlMs" | "idleGraceMs" | "pollIntervalMs">(
  envKey: string,
  key: Key,
): Partial<Record<Key, number>> {
  const value = Number(process.env[envKey])
  return Number.isFinite(value) && value > 0 ? { [key]: Math.floor(value) } as Partial<Record<Key, number>> : {}
}
