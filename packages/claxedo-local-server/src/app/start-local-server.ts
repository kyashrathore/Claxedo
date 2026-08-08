/**
 * Starting the desktop-local server.
 *
 * `createLocalApp` decides what is SERVED; this decides what is RUNNING. The
 * split matters because the two have different failure modes: a missing route
 * is a 404 someone notices, while a missing lifecycle wire is a feature that
 * silently never works.
 *
 * What this deliberately does NOT start is as much the point as what it does:
 *
 *   - **No workspace supervisor.** It exists to provision and reap cloud
 *     sandboxes, and this product has none. Runtime dispatch already reaches it
 *     through a port that correctly no-ops, so leaving it unconfigured is the
 *     composition stating "no cloud provisioning here" rather than a gap.
 *   - **No control-plane authority, relay, Documents, Connections, Channels or
 *     WorkGraph.** Those are the hosted product.
 *
 * Both omissions are asserted rather than assumed — see
 * `start-local-server.test.ts`.
 */

import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import { withDataDirOwnership } from "@claxedo/server-core/platform/runtime/lib/data-dir-owner"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { workspaceSupervisorInstalled } from "@claxedo/server-core/workspace/supervisor-port"
import {
  configureOpenCodeEngine,
  configureOpenCodeEmbedPath,
  opencodeRequest,
} from "@claxedo/server-core/opencode/engine"
import { configureOpenCodeAuth, opencodeHeaders } from "@claxedo/server-core/opencode/auth"
import { configureAgentConfig } from "@claxedo/server-core/agent-config/index"
import { createLocalApp, type LocalAppOptions } from "./local-app"
import { createLocalControlPlaneServices } from "./local-services"
import { configureEmbeddedWorkspaceRuntime, shutdownEmbeddedWorkspaceRuntimes } from "../deployments/local/embedded-workspace-runtime"
import { configureOpencodeMcpSync } from "../opencode/mcp-sync"
import { createOpencodeEvents } from "../opencode/events"
import { projectLocalSessionMetaFromEvent, sessionMetaProjectionTap } from "../session/session-meta-tap"
import { migrateCredentials } from "../credentials/operations/migrate"
import { DEFAULT_CLAXEDO_SERVER_PORT } from "../deployments/local/port"

const log = Log.create({ service: "local-server" })

export type StartLocalServerOptions = Omit<LocalAppOptions, "onError" | "services"> & {
  services?: LocalAppOptions["services"]
  port?: number
  hostname?: string
  /** An explicit URL opts out of the embedded engine. */
  opencodeUrl?: string
  opencodePassword?: string | null
  opencodeEmbedPath?: string
  onError?: LocalAppOptions["onError"]
  /** Desktop diagnostics observer for spawned harness processes. */
  processObserver?: Parameters<typeof configureEmbeddedWorkspaceRuntime>[0]["processObserver"]
}

export type LocalServer = {
  port: number
  /**
   * The interface actually bound.
   *
   * Exposed because "loopback only" is the desktop's whole network threat
   * model, and the bind address is the control that enforces it — not any route
   * guard. Connecting to `0.0.0.0` from the same machine reaches a loopback
   * listener anyway, so a reachability probe cannot tell the two apart; the
   * bound address can.
   */
  hostname: string
  app: Hono
  /** Stops accepting connections and releases everything this started. */
  stop: () => Promise<void>
}

export function startLocalServer(options: StartLocalServerOptions): LocalServer {
  return withDataDirOwnership(dataDir(), (owner) => {
    const release = () => {
      try {
        owner.release()
      } catch (error) {
        log.warn("failed to release data directory ownership", { error: String(error) })
      }
    }
    process.once("exit", release)
    try {
      return startOwned(options, release)
    } catch (error) {
      process.off("exit", release)
      release()
      throw error
    }
  })
}

function startOwned(options: StartLocalServerOptions, release: () => void): LocalServer {
  const port = options.port ?? DEFAULT_CLAXEDO_SERVER_PORT
  const services = options.services ?? createLocalControlPlaneServices()
  const opencodeCompat = process.env.CLAXEDO_DISABLE_OPENCODE_COMPAT !== "1"

  configureOpenCodeAuth(options.opencodePassword ?? null)
  if (options.opencodeEmbedPath) configureOpenCodeEmbedPath(options.opencodeEmbedPath)
  if (options.opencodeUrl) {
    configureOpenCodeEngine({ url: options.opencodeUrl, headers: opencodeHeaders() })
  } else {
    configureOpenCodeEngine({ embedded: true })
  }

  configureOpencodeMcpSync({ enabled: opencodeCompat })
  configureEmbeddedWorkspaceRuntime({
    opencodeRequest,
    opencodeCompat,
    ...(options.processObserver ? { processObserver: options.processObserver } : {}),
    // No route contributions: WorkGraph is a hosted capability, and its absence
    // from an unsigned desktop is this line rather than a runtime flag.
    routeContributions: [],
    // Both halves of session-metadata recording. The tap in `createLocalApp`
    // sees HTTP mutations; this sees a harness's ASYNC auto-title, which is
    // published only on the workspace's own event stream. Without it, titles
    // revert to "Untitled" after a restart.
    onSessionMetaEvent: (event) => {
      if (event.payload.type === "session.created" || event.payload.type === "session.updated") {
        void projectLocalSessionMetaFromEvent(services.projectionStore, event)
      }
    },
    onSessionMetaSnapshot: async (workspace, sessions) => {
      await Promise.all(sessions.map((session) => services.projectionStore.sync_session_meta(workspace, session)))
    },
  })
  configureAgentConfig({
    ...(process.env.CLAXEDO_ACP_DIR ? { acpDir: process.env.CLAXEDO_ACP_DIR } : {}),
    // No remote authority: this product has no control plane to ask, so the
    // local SQLite authority answers.
    runtimeWorkspaceAuthority: () => undefined,
  })

  // Opened here so the first session-list request does not pay for migrations,
  // repair checks and statement preparation.
  ClaxedoDB.raw()

  // Deferred and non-blocking: a credential migration must never gate startup.
  migrateCredentials().catch((error) => {
    log.warn("credential migration failed", { error: String(error) })
  })

  const { app, injectWebSocket } = createLocalApp({ ...options, services })
  const upstreamEvents = opencodeCompat ? createOpencodeEvents(opencodeRequest, { autoStart: false }) : undefined

  const hostname = options.hostname ?? (process.env.CLAXEDO_SERVER_HOST?.trim() || "127.0.0.1")
  const server = serve({ fetch: app.fetch, port, hostname })
  injectWebSocket(server)

  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    upstreamEvents?.close()
    shutdownEmbeddedWorkspaceRuntimes()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    process.off("exit", release)
    release()
  }

  log.info("local server listening", {
    port,
    hostname,
    opencode: options.opencodeUrl ? "external" : "embedded",
    compat: opencodeCompat,
    // Stated at boot: a supervisor here would mean cloud provisioning, which
    // this product does not do.
    supervisor: workspaceSupervisorInstalled(),
  })

  return { port, hostname, app, stop }
}

export { sessionMetaProjectionTap }
