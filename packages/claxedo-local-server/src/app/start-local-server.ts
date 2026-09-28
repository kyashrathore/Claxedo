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
import os from "node:os"
import path from "node:path"
import type { Duplex } from "node:stream"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { controlPlaneAuthContext } from "@claxedo/server-core/platform/auth/auth"
import { isLoopbackLocalRequest } from "@claxedo/server-core/platform/http/peer-address"
import { localHistoryClassifier } from "@claxedo/server-core/usage/local-history-classifier"
import { createTurnMeter } from "@claxedo/server-core/usage/turn-meter"
import { meteringHarnessId } from "@claxedo/server-core/session/harness/index"
import type { CompatEnvelope } from "@claxedo/agent-sdk-runtime"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import { withDataDirOwnership } from "@claxedo/server-core/platform/runtime/lib/data-dir-owner"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { workspaceSupervisorInstalled } from "@claxedo/server-core/workspace/supervisor-port"
import { configureAgentConfig, disposeAgentConfig } from "@claxedo/server-core/agent-config/index"
import { defaultConnectionConfigs } from "@claxedo/server-core/agent-config/connections"
import { createLocalApp, type LocalAppOptions } from "./local-app"
import { createLocalControlPlaneServices } from "./local-services"
import {
  configureEmbeddedWorkspaceRuntime,
  ensureEmbeddedWorkspaceRuntime,
  startEmbeddedWorkspaceRuntimeConfigRenewal,
  readEmbeddedWorkspaceSessionConfig,
  shutdownEmbeddedWorkspaceRuntimes,
  verifyEmbeddedRuntimeCredential,
  type EmbeddedRetirementResult,
} from "../deployments/local/embedded-workspace-runtime"
import { CLAXEDO_MCP_TOOL_GROUPS } from "@claxedo/mcp"
import { localBuiltinToolGroupsReader } from "../agent-plugins/builtin-groups"
import { createClaxedoMcpClient } from "@claxedo/mcp/client"
import { projectLocalSessionMetaFromEvent, sessionMetaProjectionTap } from "../session/session-meta-tap"
import { dropCopiedHarnessLogins } from "../credentials/operations/drop-copied-harness-logins"
import { createLocalCredentialBroker } from "../credentials/broker"
import { hostCredentialProjectAuth, localMachineOwnerUserId } from "../workspace/host-provider-config"
import { requestOrg } from "../credentials/routes/credential"
import { createUsageQuotaReader } from "@claxedo/server-core/usage/quota"
import { tokenTrackerPricing } from "@claxedo/server-core/usage/adapters/token-tracker-pricing"
import { DEFAULT_CLAXEDO_SERVER_PORT } from "../deployments/local/port"
import { createSqliteUsageLedger } from "@claxedo/server-core/usage/adapters/sqlite-usage-ledger"
import { createSqliteUsageSourceCoverageStore } from "@claxedo/server-core/usage/adapters/sqlite-usage-provenance"
import { createSqliteTurnMeterStateStore } from "@claxedo/server-core/usage/adapters/sqlite-turn-meter-state"
import { scanTokenTrackerLocalHistory } from "../usage/adapters/token-tracker-local-history"
import { readMachineAgentUsage } from "../usage/adapters/token-tracker-usage-limits"
import { localUsageHostId } from "../usage/host-id"
import { drainUsageEvents } from "../usage/usage-event-drain"
import { createLocalWorkspaceRelayProxy } from "../workspace/runtime-dispatch/shared-workspace-endpoint"
import { localHostRelayActor, localHostSessionAccessPolicy } from "../deployments/local/host-session-authority"

const log = Log.create({ service: "local-server" })

export type StartLocalServerOptions = Omit<LocalAppOptions, "onError" | "services" | "usage" | "firstPartyMcp"> & {
  services?: LocalAppOptions["services"]
  port?: number
  hostname?: string
  onError?: LocalAppOptions["onError"]
  /** Desktop diagnostics observer for spawned harness processes. */
  processObserver?: Parameters<typeof configureEmbeddedWorkspaceRuntime>[0]["processObserver"]
  /** The Agent Plugins module's contribution to every runtime snapshot. */
  pluginRuntime?: NonNullable<Parameters<typeof configureAgentConfig>[0]>["pluginRuntime"]
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
  /**
   * Stops accepting connections and releases everything this started. `ok` is
   * false when an owner refused retirement; its `results` name each one, so a
   * launcher can report what survived instead of exiting as though nothing did.
   */
  stop: () => Promise<LocalServerStopResult>
}

export type LocalServerStopResult = {
  ok: boolean
  results: EmbeddedRetirementResult[]
}

/**
 * The one browser origin that is not this daemon's own and may still read its
 * answers: a renderer served by a development server.
 *
 * `ELECTRON_RENDERER_URL` is the launcher's explicit declaration of where the
 * renderer document lives — Electron main trusts the same variable to decide
 * which document may navigate and hold the IPC bridge, so the two surfaces
 * agree on one dev authority instead of each inventing a rule. A packaged
 * desktop sets nothing here and the daemon answers its own origin only; a value
 * that is not a URL is a launcher misconfiguration and grants nothing rather
 * than widening silently.
 */
function developmentRendererOrigins(env: NodeJS.ProcessEnv): readonly string[] {
  const declared = env.ELECTRON_RENDERER_URL?.trim()
  if (!declared) return []
  try {
    return [new URL(declared).origin]
  } catch {
    log.warn("ignoring a malformed ELECTRON_RENDERER_URL; the daemon answers its own origin only")
    return []
  }
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

  type TurnOutcomeHandler = NonNullable<Parameters<typeof configureEmbeddedWorkspaceRuntime>[0]["onTurnOutcome"]>
  let settleTurnOutcome: TurnOutcomeHandler = () => undefined
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
    // One policy for both kinds of caller: the machine's own user reaches
    // these runtimes over loopback and owns every session on them, while a
    // relayed org member is admitted only by the control plane's session
    // authority. Which one a request gets is decided from the provenance the
    // dispatch below stamps, so the declaration to the control plane is
    // `managed-private` while this window still creates sessions with no
    // reservation — signed in or out.
    sessionAccessPolicy: localHostSessionAccessPolicy,
    loopbackSessionAuthority: "local",
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
    onTurnOutcome: (outcome) => settleTurnOutcome(outcome),
    onSessionMetaCreated: async (workspace, session) => {
      await services.projectionStore.sync_session_meta(workspace, session)
    },
    onSessionMetaSnapshot: async (workspace, sessions) => {
      await services.projectionStore.sync_session_metas(workspace, sessions)
    },
    sessionIdWorkspace: async (sessionId) => (await services.projectionStore.session_meta(sessionId))?.workspaceID,
  })
  // The broker is a route on this same listener, so its origin is this server's.
  const credentialBroker = createLocalCredentialBroker({
    dataDir: dataDir(),
    brokerOrigin: firstPartyMcpBaseUrl,
    machineOwnerUserId: localMachineOwnerUserId,
  })
  configureAgentConfig({
    connectionConfigs: defaultConnectionConfigs(),
    // The broker answers with this machine's rows, the operator's named for
    // the enrolled owner; the owner's pushed rows are written over theirs.
    projectAuth: hostCredentialProjectAuth((input) => credentialBroker.projectAuth(input)),
    ...(options.pluginRuntime ? { pluginRuntime: options.pluginRuntime } : {}),
  })
  // A placeholder expires; re-projecting on this interval and re-applying the
  // snapshot is what puts the next one in front of the next turn's spawn.
  const stopConfigRenewal = startEmbeddedWorkspaceRuntimeConfigRenewal()

  // Opened here so the first session-list request does not pay for migrations,
  // repair checks and statement preparation.
  ClaxedoDB.raw()

  dropCopiedHarnessLogins().catch((error: unknown) => {
    log.warn("Failed to forget copied harness logins", { error: String(error) })
  })

  const usageRevisionStore = createSqliteUsageLedger()
  const usageSourceCoverage = createSqliteUsageSourceCoverageStore()
  const usageSourceCoverageReady = usageSourceCoverage.ensure(["claude", "codex", "cursor", "opencode", "pi"])
  const turnMeter = createTurnMeter({
    writer: usageRevisionStore,
    reader: usageRevisionStore,
    state: createSqliteTurnMeterStateStore(),
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
  settleTurnOutcome = ({ sessionId, assistantMessageId, outcome }) => {
    if (outcome.status !== "cancelled" || !assistantMessageId) return
    usageEventTail = usageEventTail
      .then(() => turnMeter.settle({
        sessionId,
        messageId: assistantMessageId,
        status: outcome.reason === "steer" ? "interrupted_by_steer" : "stopped",
      }))
      .catch((error) => log.warn("local turn outcome metering degraded", { error: String(error) }))
  }
  // One statement of the signed-auth configuration for both readers below. A
  // quota resolved from an empty one answers the single-tenant partition on a
  // signed box, so it reported another org's accounts than `identity` named.
  const authOptions = {
    authConfig: services.auth.config,
    ...(services.auth.verifier ? { verifier: services.auth.verifier } : {}),
  }
  // The same tenant the credential routes resolve, because the accounts this
  // reads are the rows those routes list.
  const readQuota = createUsageQuotaReader({ credentials: services.credentials, agentUsage: readMachineAgentUsage })
  const usage = {
    local: usageRevisionStore,
    identity: async (request: Request) => {
      const auth = await controlPlaneAuthContext(request, {
        config: authOptions.authConfig,
        ...(authOptions.verifier ? { verifier: authOptions.verifier } : {}),
      })
      return auth.mode === "signed" && auth.user.orgId
        ? { org_id: auth.user.orgId, user_id: auth.user.subject }
        : undefined
    },
    // This server has exactly one operator: whoever is on the machine's own
    // loopback. Signed or unsigned, machine history, stored quota and unowned
    // facts answer to that caller alone.
    machineOperator: (request: Request) => isLoopbackLocalRequest(request),
    quota: async ({ request, refresh }: { request: Request; refresh: boolean }) =>
      await readQuota({ org: await requestOrg(request, authOptions), refresh }),
    history: async ({ since, until, refresh }: { since: number; until: number; refresh: boolean }) => {
      await usageSourceCoverageReady
      return await scanTokenTrackerLocalHistory({
        sourceHome: os.homedir(),
        stateDir: path.join(dataDir(), "usage-scanner"),
        since,
        until,
        refresh,
        classify: localHistoryClassifier(await usageRevisionStore.localTurnSpans(), await usageSourceCoverage.starts()),
      })
    },
    pricing: tokenTrackerPricing("refreshed"),
    telemetry: services.telemetry,
  }
  // Both dispatch entrypoints resolve the same verified relay actor: one
  // answers `/workspaces/:id/*` (what the host tunnel replays onto) and the
  // other the bare runtime paths, and a caller that reached either without a
  // verifiable relay stamp is this machine's user. A composition that brings
  // its own resolver keeps it, the way it keeps its own relay proxy below.
  const runtimeProxyOptions = {
    resolveRelayActor: localHostRelayActor,
    verifyRelayIngress: true,
    ...options.runtimeProxyOptions,
  }
  const workspaceRelayProxy = options.workspaceRelayProxy ?? createLocalWorkspaceRelayProxy(runtimeProxyOptions)
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
    runtimeProxyOptions,
    egressBroker: credentialBroker.handler,
    services,
    usage,
    workspaceRelayProxy,
    refreshSessionProjection,
    ...(options.browserOrigins ? {} : { browserOrigins: developmentRendererOrigins(options.env ?? process.env) }),
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
  // `closeAllConnections` reaches only the sockets the HTTP parser still owns.
  // A WebSocket handshake hands its socket off that list, while `close()` keeps
  // waiting for it, so the drain deadline below has to end those itself.
  const upgraded = new Set<Duplex>()
  server.on("upgrade", (_request: unknown, socket: Duplex) => {
    upgraded.add(socket)
    // @hono/node-ws answers a refused upgrade with `socket.end(...)` and only
    // an accepted one gets `ws`'s error listener. A client that resets during
    // auth or after a refusal otherwise emits an unhandled 'error' (ECONNRESET)
    // that exits the daemon and every terminal it holds.
    socket.on("error", (error) => log.info("websocket upgrade socket error", { error: String(error) }))
    socket.once("close", () => upgraded.delete(socket))
  })

  let stopOperation: Promise<LocalServerStopResult> | undefined
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
        for (const socket of upgraded) socket.destroy()
      }, 5_000)
      deadline.unref()
      server.close(() => {
        clearTimeout(deadline)
        resolve()
      })
    })
    stopOperation = (async () => {
      try {
        stopConfigRenewal()
        options.daemon?.lifecycle.stop()
        // An owner this process could not retire is reported and the rest of
        // shutdown still runs. Skipping the usage drain because one workspace
        // refused teardown loses metering that had nothing to do with it.
        const retirement = await shutdownEmbeddedWorkspaceRuntimes()
        for (const result of retirement.results) {
          if (result.state === "retired") continue
          log.error("workspace runtime retirement failed during shutdown", {
            workspace_id: result.workspaceId,
            state: result.state,
            attempt: result.attempt,
            error: result.error,
          })
        }
        await drainUsageEvents(usageEventTail, turnMeter)
        return retirement
      } finally {
        await listenerClosed
        disposeAgentConfig()
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
    pid: process.pid,
    opencode: "embedded-sdk",
    // Stated at boot: a supervisor here would mean cloud provisioning, which
    // this product does not do.
    supervisor: workspaceSupervisorInstalled(),
  })

  return { port, hostname, app, ready, stop }
}

export { sessionMetaProjectionTap }
