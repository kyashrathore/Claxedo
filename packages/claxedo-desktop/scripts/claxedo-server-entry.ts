// The desktop-local product, not the mixed self-hosted composition. This is
// the line that keeps an unsigned desktop from closing over the hosted control
// plane: `@claxedo/local-server` cannot reach Documents, Connections, Channels,
// a workspace authority, or cloud provisioning, and its own closure test
// asserts so.
import { createLocalDaemonLifecycle, startLocalServer } from "@claxedo/local-server/self-hosted-execution"
import { claxedoDaemonOwnershipPath, clearDaemonOwnershipSnapshot, createDaemonOwnershipPublisher, localDaemonOperationStore } from "@claxedo/local-server/self-hosted-execution"
import { createLocalAgentPluginsComposition } from "@claxedo/local-server/agent-plugins/local-composition"
import { createLocalTasksComposition } from "@claxedo/local-server/tasks/local-composition"
import { localBuiltinToolGroupsReader } from "@claxedo/local-server/agent-plugins/builtin-groups"
import { BUILTIN_TASKS_TOOL_GROUP } from "@claxedo/server-core/agent-plugins/builtin/plugin"
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
import { readCreationIdentity, type CreationIdentity } from "@claxedo/agent-sdk-runtime/launch"
import path from "node:path"

// The V8 compile cache is already enabled and already seeded by the time this
// module is COMPILED, let alone evaluated: `claxedo-server-boot.ts` is the
// bundle's entry and reaches this file through a dynamic import. It cannot be
// done from here — a graph is compiled before its own bodies run, so a cache
// switched on in this body would arrive 9.11 MB too late.
//
// Before any composition is created: the compile-cache build evaluates this
// chunk with the startup variables absent and relies on this throw to stop it.
// Creating the Agent Plugins composition opens `claxedo.db` and applies
// migrations, so anything ahead of this line runs against the developer's real
// data directory during `predev` and `prebuild`.
const startup = claxedoServerStartup(process.env)

const agentPlugins = createLocalAgentPluginsComposition()
// The Marketplace switch decides both halves at once: no Tasks tools for a
// session, and no grant left answering for one that still holds a handle.
const builtinToolGroups = localBuiltinToolGroupsReader()
const tasks = createLocalTasksComposition({ enabled: () => builtinToolGroups().includes(BUILTIN_TASKS_TOOL_GROUP) })
void agentPlugins.ready.catch((error) => {
  console.error("Agent Plugins startup reconciliation failed", error)
})

const parent = diagnosticsParent()
const binding = diagnosticsBinding(process.env, Boolean(parent))
const transport = binding && parent
  ? createDiagnosticsChildTransport({ binding, send: parent.send })
  : undefined
parent?.listen((message) => void transport?.onMessage(message))

let requestStop: () => void | Promise<unknown> = () => {}
let requestExit = () => {}
const lifecycle = createLocalDaemonLifecycle({
  // Resolves only when the server has actually released its owners, so the
  // receipt this stop earns is written against what stopping reached.
  onStop: () => requestStop(),
  onStopped: () => requestExit(),
  machine: {
    machineId: "local",
    generation: startup.daemonGeneration,
    operations: localDaemonOperationStore(),
    // Survivors of the previous owner reach an operator here. This process
    // does not signal them: retiring one belongs to the workspace store that
    // owns it, and what admission needs is only that each has been accounted
    // for before work is let in.
    onLaunchReconciled: (launch) => {
      if (launch.execution === "none") return
      console.error(
        `unsettled ${launch.role} launch ${launch.launchId} from generation ${launch.ownerGeneration} `
          + `in workspace ${launch.workspaceId}: `
          + `execution ${launch.execution} (${launch.because})`
          + (launch.identity ? `, recorded process is ${launch.identity}` : ""),
      )
    },
    onLaunchesUnreadable: (workspaceId, reason) => {
      console.error(workspaceId === undefined
        ? `this machine's workspace ownership could not be read for unsettled launches: ${reason}`
        : `workspace ${workspaceId} could not be read for unsettled launches: ${reason}`)
    },
  },
  ...positiveDuration("CLAXEDO_DAEMON_LEASE_TTL_MS", "leaseTtlMs"),
  ...positiveDuration("CLAXEDO_DAEMON_IDLE_GRACE_MS", "idleGraceMs"),
  ...positiveDuration("CLAXEDO_DAEMON_POLL_INTERVAL_MS", "pollIntervalMs"),
})
const ownershipPath = claxedoDaemonOwnershipPath(path.dirname(startup.daemonDiscoveryPath))
const ownership = createDaemonOwnershipPublisher({
  file: ownershipPath,
  pid: process.pid,
  inspect: () => lifecycle.recovery.inspect(),
  onError: (error) => console.error("publishing the daemon ownership snapshot failed", error),
})
/**
 * This process's OS creation identity, read once the listener is up. A launcher
 * that has to signal this daemon after the app restarted compares it before it
 * sends anything, so it is published rather than left for a pid probe to guess.
 */
let creation: CreationIdentity | undefined
const server = startLocalServer({
  port: startup.port,
  daemon: {
    identity: {
      token: startup.daemonToken,
      protocol: startup.daemonProtocol,
      generation: startup.daemonGeneration,
      pid: process.pid,
      creation: () => creation,
    },
    lifecycle,
  },
  ...(transport ? { processObserver: transport.observer } : {}),
  routeContributions: [...agentPlugins.routeContributions, ...tasks.routeContributions],
  tasksGrants: tasks.grants,
  harnessLaunch: agentPlugins.harnessLaunch,
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
const clearDiscovery = () => {
  clearClaxedoDaemonDiscovery(startup.daemonDiscoveryPath, discovery)
  clearDaemonOwnershipSnapshot(ownershipPath, { pid: process.pid, generation: startup.daemonGeneration })
}
process.once("exit", clearDiscovery)

let stopping: Promise<number> | undefined
/**
 * Releases everything this process owns and answers with the exit code that
 * outcome earns. It does NOT exit: a `stop_daemon` receipt is written after
 * this resolves, and a process that exits here would leave that receipt saying
 * the machine still had work — which then fences the next generation from boot.
 * Exiting is `exit()` below, once whoever asked has its answer.
 */
const stop = () => {
  stopping ??= server.stop().then(
    (outcome) => {
      ownership.stop()
      for (const result of outcome.results) {
        if (result.state === "retired") continue
        console.error(`workspace ${result.workspaceId} was not retired (${result.state}): ${result.error ?? "no reason recorded"}`)
      }
      // The exit code is the outcome, not a formality: an owner this process
      // could not retire is still holding resources, and exiting 0 over it
      // tells the launcher a replacement is safe to start.
      return outcome.ok ? 0 : 75
    },
    (error: unknown) => {
      ownership.stop()
      console.error("the local server refused to stop", error)
      return 75
    },
  )
  return stopping
}

const exit = () => {
  void stop().then((code) => {
    clearDiscovery()
    process.exit(code)
  })
}
requestStop = stop
requestExit = exit
process.once("SIGTERM", exit)
process.once("SIGINT", exit)

void server.ready.then(async () => {
  // FIRST, before this port is announced to anyone: start() is what closes
  // machine admission for the launch reconciliation, and a listener that is
  // reachable before that hold exists admits work over launches nothing has
  // accounted for yet.
  lifecycle.start()
  // THEN the discovery record, and only then the ready message: main reads the
  // record as soon as it hears ready, and a record that is not there yet reads
  // as a daemon that never published its authenticated identity.
  await publishIdentity()
  parent?.send(claxedoServerReadyMessage(startup.port))
  recordStartupClock("server-listening", { port: startup.port })
  ownership.start()
})

/**
 * Publishes the discovery record once this process can say what it is.
 *
 * A record without the creation identity is worse than a late one: a launcher
 * that adopts it has nothing to verify before signalling. So the subprocess
 * this costs is paid before anyone is told the port exists.
 */
async function publishIdentity() {
  creation = await readCreationIdentity(process.pid)
  writeClaxedoDaemonDiscovery(startup.daemonDiscoveryPath, {
    ...discovery,
    ...(creation ? { identity: creation } : {}),
  })
}

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
  if (!process.parentPort) return undefined
  return {
    send: (message: Parameters<typeof process.parentPort.postMessage>[0]) => process.parentPort.postMessage(message),
    listen: (listener: (message: unknown) => void) => process.parentPort.on("message", (event) => listener(event.data)),
  }
}

function diagnosticsBinding(env: NodeJS.ProcessEnv, connected: boolean): DiagnosticsBinding | undefined {
  const launchId = env.CLAXEDO_DIAGNOSTICS_LAUNCH_ID?.trim()
  const generation = env.CLAXEDO_DIAGNOSTICS_GENERATION?.trim()
  if (!connected || !launchId || !generation) return undefined
  return { pid: process.pid, launchId, generation }
}

function positiveDuration<Key extends "leaseTtlMs" | "idleGraceMs" | "pollIntervalMs">(
  envKey: string,
  key: Key,
): Partial<Record<Key, number>> {
  const value = Number(process.env[envKey])
  if (!Number.isFinite(value) || value <= 0) return {}
  // Built as a typed record rather than asserting a computed-key literal into
  // one: `{ [key]: n }` widens to `{ [x: string]: number }` on its own.
  const duration: Partial<Record<Key, number>> = {}
  duration[key] = Math.floor(value)
  return duration
}
