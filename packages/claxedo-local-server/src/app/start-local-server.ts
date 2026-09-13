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
 *   - **No control-plane authority, relay, Documents, Connections or
 *     Channels.** Those are the hosted product.
 *
 * Both omissions are asserted rather than assumed — see
 * `start-local-server.test.ts`.
 */

import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { controlPlaneAuthContext } from "@claxedo/server-core/platform/auth/auth"
import { createUsageProvenanceClassifier, tokenTrackerSourceForHarness } from "@claxedo/server-core/usage/provenance"
import { createTurnMeter } from "@claxedo/server-core/usage/turn-meter"
import { meteringHarnessId } from "@claxedo/server-core/session/harness/index"
import { createAcpConnectionProvider, type CompatEnvelope } from "@claxedo/agent-sdk-runtime"
import { createOpenCodeServerConnectionProvider } from "@claxedo/opencode-server-adapter"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import { withDataDirOwnership } from "@claxedo/server-core/platform/runtime/lib/data-dir-owner"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { workspaceSupervisorInstalled } from "@claxedo/server-core/workspace/supervisor-port"
import { drainOpenCodeSdkRuntime, openCodeSdkRuntime } from "@claxedo/server-core/opencode/sdk-runtime"
import { configureAgentConfig, disposeAgentConfig } from "@claxedo/server-core/agent-config/index"
import { createLocalApp, type LocalAppOptions } from "./local-app"
import { createLocalControlPlaneServices } from "./local-services"
import {
  configureEmbeddedWorkspaceRuntime,
  ensureEmbeddedWorkspaceRuntime,
  readEmbeddedWorkspaceSessionConfig,
  shutdownEmbeddedWorkspaceRuntimes,
  verifyEmbeddedRuntimeCredential,
} from "../deployments/local/embedded-workspace-runtime"
import { CLAXEDO_MCP_TOOL_GROUPS } from "@claxedo/mcp"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { localBuiltinToolGroupsReader } from "../agent-plugins/builtin-groups"
import { createClaxedoMcpClient } from "@claxedo/mcp/client"
import { projectLocalSessionMetaFromEvent, sessionMetaProjectionTap } from "../session/session-meta-tap"
import { migrateCredentials } from "../credentials/operations/migrate"
import { DEFAULT_CLAXEDO_SERVER_PORT } from "../deployments/local/port"
import { getLocalUsageLimits } from "../deployments/local/server-usage-limits"
import { createSqliteUsageLedger } from "@claxedo/server-core/usage/adapters/sqlite-usage-ledger"
import { createSqliteUsageSourceCoverageStore } from "@claxedo/server-core/usage/adapters/sqlite-usage-provenance"
import { scanTokenTrackerLocalHistory } from "../usage/adapters/token-tracker-local-history"
import { createUsageOutboxSync } from "../usage/outbox-sync"
import { localUsageHostId } from "../usage/host-id"
import { drainUsageEvents } from "../usage/usage-event-drain"
import { createLocalWorkspaceRelayProxy } from "../workspace/runtime-dispatch/shared-workspace-endpoint"

const log = Log.create({ service: "local-server" })

export type StartLocalServerOptions = Omit<LocalAppOptions, "onError" | "services" | "usage" | "firstPartyMcp"> & {
  services?: LocalAppOptions["services"]
  port?: number
  hostname?: string
  onError?: LocalAppOptions["onError"]
  /** Desktop diagnostics observer for spawned harness processes. */
  processObserver?: Parameters<typeof configureEmbeddedWorkspaceRuntime>[0]["processObserver"]
  /** Opaque launch options supplied by an optional harness feature module. */
  harnessLaunch?: NonNullable<Parameters<typeof configureAgentConfig>[0]>["harnessLaunch"]
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
  /** Resolves when the listener accepts connections; see startOwned. */
  ready: Promise<void>
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
  const connectionProviders = [
    createAcpConnectionProvider(),
    createOpenCodeServerConnectionProvider(),
  ] as const
  // One process-owned public embedded-SDK runtime, shared by every embedded
  // workspace runtime this server creates; it is the native `opencode` harness.
  const opencodeRuntime = openCodeSdkRuntime()

  let consumeRuntimeEvent = (event: CompatEnvelope) => {
    if (event.payload.type === "session.updated") {
      void projectLocalSessionMetaFromEvent(services.projectionStore, event)
    }
  }
  // The origin this process serves the first-party MCP on. `port` is the bound
  // port: `serve()` below is given it explicitly and every caller reads back
  // the same number as this server's address.
  const firstPartyMcpBaseUrl = `http://127.0.0.1:${port}`
  // One reader for both halves: the runtime decides whether a session gets the
  // endpoint at all, and the mount decides which tools it serves, from the
  // same machine-wide activation rows.
  const builtinToolGroups = localBuiltinToolGroupsReader()
  configureEmbeddedWorkspaceRuntime({
    connectionProviders,
    opencodeRuntime,
    firstPartyMcpLaunch: { baseUrl: firstPartyMcpBaseUrl, enabledToolGroups: builtinToolGroups },
    ...(options.processObserver ? { processObserver: options.processObserver } : {}),
    // No route contributions: hosted capabilities contribute routes, and their
    // absence from an unsigned desktop is this line rather than a runtime flag.
    routeContributions: [],
    // Both halves of session-metadata recording. The tap in `createLocalApp`
    // sees HTTP mutations; this sees a harness's ASYNC auto-title, which is
    // published only on the workspace's own event stream. Without it, titles
    // revert to "Untitled" after a restart.
    onSessionMetaEvent: (event) => consumeRuntimeEvent(event),
    onSessionMetaCreated: async (workspace, session) => {
      await services.projectionStore.sync_session_meta(workspace, session)
    },
    onSessionMetaSnapshot: async (workspace, sessions) => {
      await services.projectionStore.sync_session_metas(workspace, sessions)
    },
  })
  configureAgentConfig({
    connectionProviders,
    ...(options.harnessLaunch ? { harnessLaunch: options.harnessLaunch } : {}),
  })

  // Opened here so the first session-list request does not pay for migrations,
  // repair checks and statement preparation.
  ClaxedoDB.raw()

  // Deferred and non-blocking: a credential migration must never gate startup.
  migrateCredentials().catch((error) => {
    log.warn("credential migration failed", { error: String(error) })
  })

  const usageRevisionStore = createSqliteUsageLedger()
  const usageSourceCoverage = createSqliteUsageSourceCoverageStore()
  const usageSourceCoverageReady = usageSourceCoverage.ensure(["claude", "codex", "cursor", "opencode", "pi"])
  const usageOutbox = createUsageOutboxSync({ local: usageRevisionStore, telemetry: services.telemetry })
  const turnMeter = createTurnMeter({
    writer: usageRevisionStore,
    reader: usageRevisionStore,
    currentFilter: (fact) => fact.location === "local",
    reconcileProvisionalOnStart: true,
    resolveContext: async ({ sessionId }) => {
      const [meta, hostId] = await Promise.all([
        services.projectionStore.session_meta(sessionId),
        localUsageHostId(),
      ])
      if (!meta?.sessionRef || !meta.workspaceID) {
        throw new Error(`usage metering requires canonical workspace session metadata for ${sessionId}`)
      }
      const config = readEmbeddedWorkspaceSessionConfig(meta.workspaceID, sessionId)
      const meteringHarness = meteringHarnessId(config.harness)
      return {
        sessionRef: meta.sessionRef,
        workspaceId: meta.workspaceID,
        hostId,
        location: "local" as const,
        harness: meteringHarness,
        ...(config.model?.providerID ? { providerId: config.model.providerID } : {}),
        ...(config.model?.modelID ? { modelId: config.model.modelID } : {}),
        ...(meteringHarness === "pi" ? { nativeSessionId: sessionId } : {}),
      }
    },
    onTerminal: async () => { await usageOutbox.notify() },
    onDegraded: (error) => log.warn("local usage metering degraded", { error: String(error) }),
  })
  void turnMeter.start()
  let usageEventTail = Promise.resolve()
  consumeRuntimeEvent = (event) => {
    usageEventTail = usageEventTail.then(async () => {
      if (event.payload.type === "session.updated") {
        await projectLocalSessionMetaFromEvent(services.projectionStore, event)
      }
      if (typeof event.payload.type === "string" && event.payload.properties) {
        await turnMeter.consume(event)
      }
    }).catch((error) => log.warn("local runtime event projection degraded", { error: String(error) }))
  }
  const usage = {
    local: usageRevisionStore,
    outbox: usageOutbox,
    identity: async (request: Request) => {
      const auth = await controlPlaneAuthContext(request, {
        config: services.auth.config,
        ...(services.auth.verifier ? { verifier: services.auth.verifier } : {}),
      })
      return auth.mode === "signed" && auth.user.orgId
        ? { org_id: auth.user.orgId, user_id: auth.user.subject }
        : undefined
    },
    quota: async (refresh: boolean) => await getLocalUsageLimits({ refresh }),
    history: async ({ since, until, refresh }: { since: number; until: number; refresh: boolean }) => {
      await usageSourceCoverageReady
      const facts = await usageRevisionStore.current()
      const incompleteSources = new Set<string>()
      const entries = facts.flatMap((fact) => {
        const source = tokenTrackerSourceForHarness(fact.harness)
        const nativeSessionId = fact.nativeSessionId ?? (source === "pi" ? fact.sessionId : undefined)
        if (source && !nativeSessionId) incompleteSources.add(source)
        return source && nativeSessionId ? [{
          source,
          nativeSessionId,
          sessionRef: fact.sessionRef,
          harness: fact.harness,
          ...(fact.workspaceId ? { workspaceId: fact.workspaceId } : {}),
          startedAt: fact.observedAt,
          ...(fact.completedAt === undefined ? {} : { endedAt: fact.completedAt }),
        }] : []
      })
      // `current()` is the authoritative set of facts that contributes to the
      // Claxedo series. A scanner row can overlap Total only when its native
      // session appears in that set. Historical rows that have no contributing
      // Claxedo fact are valid local history, not installation-time unknowns.
      const completeAfter = Object.fromEntries(
        Object.entries(await usageSourceCoverage.starts())
          .filter(([source]) => !incompleteSources.has(source)),
      )
      const classificationKey = createHash("sha256").update(JSON.stringify({
        entries: entries.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        completeAfter,
      })).digest("hex")
      return await scanTokenTrackerLocalHistory({
        sourceHome: os.homedir(),
        stateDir: path.join(dataDir(), "usage-scanner"),
        since,
        until,
        classificationKey,
        refresh,
        classify: createUsageProvenanceClassifier(entries, { completeAfter }),
      })
    },
    telemetry: services.telemetry,
  }
  const workspaceRelayProxy = options.workspaceRelayProxy ?? createLocalWorkspaceRelayProxy()
  const sessionProjectionReady = new Map<string, Promise<void>>()
  const refreshSessionProjection: NonNullable<LocalAppOptions["refreshSessionProjection"]> = (workspace) => {
    const ready = sessionProjectionReady.get(workspace.id)
    if (ready) return ready
    const pending = ensureEmbeddedWorkspaceRuntime(workspace, { config: "skip" }).then(() => {})
    sessionProjectionReady.set(workspace.id, pending)
    void pending.catch(() => sessionProjectionReady.delete(workspace.id))
    return pending
  }
  const { app, injectWebSocket } = createLocalApp({
    ...options,
    services,
    usage,
    workspaceRelayProxy,
    refreshSessionProjection,
    firstPartyMcp: {
      verifyRuntimeCredential: verifyEmbeddedRuntimeCredential,
      createClient: (input) => createClaxedoMcpClient(input),
      registerTools: CLAXEDO_MCP_TOOL_GROUPS,
      enabledToolGroups: builtinToolGroups,
    },
  })

  const hostname = options.hostname ?? (process.env.CLAXEDO_SERVER_HOST?.trim() || "127.0.0.1")
  // The listening event resolves `ready` for callers that must not announce
  // the URL before the socket accepts connections (the desktop child sends
  // its ready IPC from it, and Electron main health-checks immediately on
  // receipt). Nothing here awaits it — startOwned stays synchronous through
  // serve(), which the compile-cache boot ordering depends on.
  let stopping = false
  const server = serve({
    fetch: (request, env) => stopping
      ? new Response("Server is stopping", { status: 503, headers: { connection: "close" } })
      : app.fetch(request, env),
    port,
    hostname,
  })
  const ready = new Promise<void>((resolve) => {
    server.once("listening", () => resolve())
  })
  injectWebSocket(server)

  let stopOperation: Promise<void> | undefined
  const stop = () => {
    if (stopOperation) return stopOperation
    stopping = true
    // Close ingress synchronously with the stop decision. Runtime and usage
    // teardown awaits below; leaving the listener open until those drains
    // finished allowed a new mutation to enter after lifecycle had already
    // committed to idle shutdown.
    const listenerClosed = new Promise<void>((resolve) => {
      // Drain responses, including the shutdown acknowledgment that initiated
      // stop. Bound the drain so an SSE stream or stalled client cannot keep
      // an otherwise idle daemon resident. Ingress is already rejected above.
      const deadline = setTimeout(() => {
        ;(server as typeof server & { closeAllConnections?: () => void }).closeAllConnections?.()
      }, 5_000)
      deadline.unref()
      server.close(() => {
        clearTimeout(deadline)
        resolve()
      })
    })
    stopOperation = (async () => {
      try {
        options.daemon?.lifecycle.stop()
        await shutdownEmbeddedWorkspaceRuntimes()
        await drainUsageEvents(usageEventTail, turnMeter)
      } finally {
        await listenerClosed
        disposeAgentConfig()
        await drainOpenCodeSdkRuntime()
        ClaxedoDB.close()
        process.off("exit", release)
        release()
      }
    })()
    return stopOperation
  }

  log.info("local server listening", {
    port,
    hostname,
    opencode: "embedded-sdk",
    // Stated at boot: a supervisor here would mean cloud provisioning, which
    // this product does not do.
    supervisor: workspaceSupervisorInstalled(),
  })

  return { port, hostname, app, ready, stop }
}

export { sessionMetaProjectionTap }
