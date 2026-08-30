import {
  createWorkspaceOpenCodeRuntime,
  loopbackWorkspaceRuntimeExposure,
  startServer,
} from "@claxedo/workspace-runtime"
import { findFreePort } from "@claxedo/workspace-runtime/host"
import type { WorkspaceRelayHostTunnelEvent } from "@claxedo/workspace-runtime/relay"
import { upsertHostRecord } from "./state"
import type { RegisteredHost } from "./register"
import { config } from "../config"

function tunnelEvent(event: WorkspaceRelayHostTunnelEvent) {
  if (event.type === "open") {
    console.log("Relay tunnel connected")
    return
  }
  if (event.type === "reconnecting") {
    console.log(`Relay tunnel reconnecting in ${event.delayMs}ms`)
    return
  }
  if (event.type === "auth-failed") {
    console.error(`Relay tunnel auth failed: ${event.error}`)
  }
}

export async function startHost(input: RegisteredHost, detached: boolean) {
  const runtimePort = await findFreePort()
  const opencodeRuntime = createWorkspaceOpenCodeRuntime(input.directory)
  startServer(runtimePort, {
    exposure: loopbackWorkspaceRuntimeExposure(),
    target: {
      workspaceId: input.workspaceId,
      directory: input.directory,
    },
    // This standalone host owns the public embedded SDK runtime. There is no
    // URL proxy, sidecar process, or compatibility server in this composition.
    opencodeRuntime,
    ownsOpenCodeRuntime: true,
    hostTunnel: {
      relayUrl: input.relayUrl,
      hostId: input.hostId,
      workspaceIds: [input.workspaceId],
      localBaseUrl: `http://127.0.0.1:${runtimePort}`,
      tokenProvider: input.tokenProvider,
      onEvent: tunnelEvent,
    },
    // This CLI owns its process: opt in to the kit's signal-driven drain so
    // SIGTERM/SIGINT close the relay tunnel and drain sessions before exit
    // (the kit default registers no process handlers).
  }, { signals: true })
  await waitForRuntimeHealth(runtimePort)
  await upsertHostRecord({
    workspaceId: input.workspaceId,
    hostId: input.hostId,
    directory: input.directory,
    displayName: input.displayName,
    controlPlaneUrl: config().controlPlaneUrl,
    appUrl: config().appUrl,
    relayUrl: input.relayUrl,
    runtimePort,
    pid: process.pid,
    detached,
    updatedAt: Date.now(),
  })
  const interval = setInterval(() => {
    void input.heartbeat().catch((err: unknown) => {
      console.error(`Heartbeat failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }, 25_000)
  process.once("exit", () => clearInterval(interval))
  return { runtimePort }
}

async function waitForRuntimeHealth(runtimePort: number) {
  const started = Date.now()
  while (Date.now() - started < 10_000) {
    try {
      const res = await fetch(`http://127.0.0.1:${runtimePort}/api/wr/health`)
      if (res.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Workspace runtime did not become healthy on port ${runtimePort}`)
}
