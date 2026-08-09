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
import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { controlPlaneAuthContext } from "@claxedo/server-core/platform/auth/auth"
import { createUsageProvenanceClassifier, tokenTrackerSourceForHarness } from "@claxedo/server-core/usage/provenance"
import { createTurnMeter } from "@claxedo/server-core/usage/turn-meter"
import { meteringHarnessId } from "@claxedo/server-core/session/harness/index"
import { resolveHarnessForRequest } from "@claxedo/server-core/session/harness/resolution"
import type { CompatEnvelope } from "@claxedo/agent-sdk-runtime"
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
import { createOpencodeEvents, type OpencodeEvent } from "../opencode/events"
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

export type StartLocalServerOptions = Omit<LocalAppOptions, "onError" | "services" | "usage"> & {
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

  let consumeRuntimeEvent = (event: OpencodeEvent) => {
    if (event.payload.type === "session.created" || event.payload.type === "session.updated") {
      void projectLocalSessionMetaFromEvent(services.projectionStore, event)
    }
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
    onSessionMetaEvent: (event) => consumeRuntimeEvent(event),
    onSessionMetaCreated: async (workspace, session) => {
      await services.projectionStore.sync_session_meta(workspace, session)
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
      const harness = await resolveHarnessForRequest({ sessionId, workspaceId: meta.workspaceID, directory: meta.directory })
      const meteringHarness = meteringHarnessId(harness)
      return {
        sessionRef: meta.sessionRef,
        workspaceId: meta.workspaceID,
        hostId,
        location: "local" as const,
        harness: meteringHarness,
        ...(meta.model?.providerID ? { providerId: meta.model.providerID } : {}),
        ...(meta.model?.modelID ? { modelId: meta.model.modelID } : {}),
        ...(meteringHarness === "opencode" || meteringHarness === "pi" ? { nativeSessionId: sessionId } : {}),
      }
    },
    onTerminal: async () => { await usageOutbox.notify() },
    onDegraded: (error) => log.warn("local usage metering degraded", { error: String(error) }),
  })
  void turnMeter.start()
  let usageEventTail = Promise.resolve()
  consumeRuntimeEvent = (event) => {
    usageEventTail = usageEventTail.then(async () => {
      if (event.payload.type === "session.created" || event.payload.type === "session.updated") {
        await projectLocalSessionMetaFromEvent(services.projectionStore, event)
      }
      if (typeof event.payload.type === "string" && event.payload.properties) {
        await turnMeter.consume(event as CompatEnvelope)
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
        const nativeSessionId = fact.nativeSessionId ?? (source === "opencode" || source === "pi" ? fact.sessionId : undefined)
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
  const { app, injectWebSocket } = createLocalApp({ ...options, services, usage, workspaceRelayProxy })
  const upstreamEvents = opencodeCompat ? createOpencodeEvents(opencodeRequest, { autoStart: false }) : undefined

  const hostname = options.hostname ?? (process.env.CLAXEDO_SERVER_HOST?.trim() || "127.0.0.1")
  const server = serve({ fetch: app.fetch, port, hostname })
  injectWebSocket(server)

  let stopOperation: Promise<void> | undefined
  const stop = () => {
    if (stopOperation) return stopOperation
    stopOperation = (async () => {
      try {
        upstreamEvents?.close()
        shutdownEmbeddedWorkspaceRuntimes()
        await drainUsageEvents(usageEventTail, turnMeter)
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
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
    opencode: options.opencodeUrl ? "external" : "embedded",
    compat: opencodeCompat,
    // Stated at boot: a supervisor here would mean cloud provisioning, which
    // this product does not do.
    supervisor: workspaceSupervisorInstalled(),
  })

  return { port, hostname, app, stop }
}

export { sessionMetaProjectionTap }
