/**
 * Node container entrypoint for the hosted Claxedo control plane.
 *
 * This serves the same Worker-safe hosted route app as `worker.ts`; only the
 * HTTP adapter is Node-specific. Local desktop/workspace routes remain in
 * `server.ts` and are intentionally not mounted here.
 */

import { serve } from "@hono/node-server"
import { createHostedApp } from "../hosted-shared/hosted-app"
import { createCentralControlApp } from "../../central-runtime"
import { createConvexUsageLedger } from "../../authority/adapters/convex/usage-ledger"
import { createControlPlaneChannels, mountControlPlaneChannels } from "../../channels/control-plane"
import { composeHostedControlPlane, type HostedControlPlane, type HostedWorkerEnv } from "../../authority/hosted-services"
import { createControlPlaneServices, defaultControlPlaneCredentials, type ControlPlaneServices } from "../../authority/services"
import { createSqliteCentralStore } from "../../authority/adapters/sqlite/central-store"
import {
  createClaxedoSessionEnvFactory,
  type WorkspaceResolver,
} from "../../hosts/workspace-runtime/session-env"
import type { SandboxFetchOptions } from "@claxedo/server-core/workspace/http/sandbox-target-fetch"
import { ControlPlaneAuthError } from "@claxedo/server-core/platform/auth/auth"
import { createConnectionTurnCredentials, type ConnectionTurnCredentials } from "../../connections/turn-credentials"
import { createHostedWorkGraphRuntime } from "../../hosts/workgraph/hosted/runtime"
import { createNodeSettlementDispatcher } from "../../hosts/workgraph/settlement-dispatcher"
import { createSqliteUsageLedger } from "@claxedo/server-core/usage/adapters/sqlite-usage-ledger"
import { localHostIdentity } from "../../workspace/local-host"

function centralStorePorts() {
  const centralStore = createSqliteCentralStore({ mode: () => "central_canonical" })
  return {
    projectionStore: centralStore.projectionStore,
    durableSessionLog: centralStore.durableSessionLog,
  }
}

export function composeHostedNodeControlPlane(env: HostedWorkerEnv = process.env): HostedControlPlane {
  const plane = composeHostedControlPlane(env)
  return {
    ...plane,
    services: createControlPlaneServices(
      centralStorePorts(),
    {
      auth: plane.services.auth,
      credentials: defaultControlPlaneCredentials(),
      extensionPolicy: plane.services.extensionPolicy,
      relay: plane.services.relay,
      sandbox: plane.services.sandbox,
      telemetry: plane.services.telemetry,
      localExecution: { enabled: false },
      ...(plane.services.defaultHomeRegion ? { defaultHomeRegion: plane.services.defaultHomeRegion } : {}),
      ...(plane.services.authority ? { authority: plane.services.authority } : {}),
    }),
  }
}

// Hosted cloud workspaces live in Convex, not the local sqlite workspace store
// that `createClaxedoSessionEnvFactory` defaults to. The workspace-runtime
// SessionEnv seam (`createEnv`) is reached with only a `SessionEnvFactoryInput`
// — there is no signed-auth context there, and the authority's `openWorkspace`
// both requires that auth and returns a differently-shaped `WorkspaceRecord`
// than the concrete `Workspace` the runtime env needs. So a correct hosted
// resolver is NOT cleanly available at this seam.
//
// Rather than silently downgrade a workspace-runtime tool sandbox to the virtual
// env (the original bug — tools would appear to run but touch nothing), the
// hosted resolver REJECTS workspace-runtime placements with an explicit,
// actionable error. The SessionEnv factory is invoked eagerly at bindSession
// time (inside createHybridSession), so this throw surfaces at SESSION CREATION,
// and — as a ControlPlaneAuthError — renders as a clean 400 through the control
// plane session route rather than a bare 500. Virtual placements (the default)
// are unaffected and keep working. When a hosted-appropriate resolver lands,
// replace this with it.
function hostedWorkspaceResolver(): WorkspaceResolver {
  return async ({ workspaceId }) => {
    throw new ControlPlaneAuthError(
      400,
      "central_hybrid_virtual_tools_only",
      `workspace-runtime tool sandbox is not supported on the hosted control plane (workspace ${workspaceId}); ` +
        "hosted cloud workspaces are Convex-backed and cannot be resolved at the session-env seam",
    )
  }
}

function hostedSessionEnvFactory(services: ControlPlaneServices, turnCredentials: ConnectionTurnCredentials) {
  const fetchOptions: SandboxFetchOptions = {
    ...(services.sandbox.sandboxManager ? { sandboxManager: services.sandbox.sandboxManager } : {}),
    ...(services.relay.provider ? { relayProvider: services.relay.provider } : {}),
    ...(services.defaultHomeRegion ? { defaultHomeRegion: services.defaultHomeRegion } : {}),
    runtimeActor: {
      principalKind: "service",
      actorId: "control-plane",
      actorKind: "agent",
    },
    role: "owner",
  }
  return createClaxedoSessionEnvFactory({
    fetchOptions,
    resolveWorkspace: hostedWorkspaceResolver(),
    turnCredentials,
  })
}

export function createHostedNodeApp(env: HostedWorkerEnv = process.env) {
  const plane = composeHostedNodeControlPlane(env)
  const turnCredentials = createConnectionTurnCredentials()
  const workGraphRuntime = createHostedWorkGraphRuntime(env, plane.services)
  const workGraphSettlementDispatcher = workGraphRuntime
    ? createNodeSettlementDispatcher({
        settle: (tenant) => workGraphRuntime.reconcile({ tenants: [tenant], trigger: "nudge" }),
      })
    : undefined
  const centralControl = createCentralControlApp(plane.services, {
    authConfig: plane.services.auth.config,
    ...(plane.services.auth.verifier ? { verifier: plane.services.auth.verifier } : {}),
    // Wire the workspace-runtime SessionEnv factory so hosted hybrid sessions do
    // not silently fall back to the virtual env. See hostedWorkspaceResolver.
    createEnv: hostedSessionEnvFactory(plane.services, turnCredentials),
    turnCredentials,
    // On the hosted plane Convex is the authoritative usage record and
    // PostHog capture stays best-effort. The ledger resolves its executor and
    // service token at call time, so it is safe to construct before secrets
    // exist. The self-host composition (server.ts) stays unwired on purpose.
    usageLedger: createConvexUsageLedger(),
    usageRevisionStore: createSqliteUsageLedger(),
    resolveUsageHostIdentity: localHostIdentity,
    productDeploymentMode: "cloud",
  })
  const channels = createControlPlaneChannels({
    services: plane.services,
    runtime: centralControl.runtime,
    env,
    includeFake: false,
  })
  const app = createHostedApp(plane, {
    centralSessionRuntime: true,
    ...(workGraphRuntime ? { workGraphReconcile: workGraphRuntime.reconcile } : {}),
    ...(workGraphSettlementDispatcher
      ? { workGraphSettlementDispatcher }
      : {}),
    workGraphNotifyOwner: ({ ownerUserId, idempotencyKey, text }) =>
      channels.notifyOwner({ ownerUserId, idempotencyKey, text }),
  })
  app.route("/", centralControl.app)
  mountControlPlaneChannels(app, {
    services: plane.services,
    runtime: centralControl.runtime,
    env,
    includeFake: false,
    requireLoopbackForFake: false,
    channels,
  })
  return app
}

export function startHostedNodeServer(input: {
  env?: HostedWorkerEnv
  port?: number
  hostname?: string
} = {}) {
  const parsedPort = input.port ?? Number(input.env?.PORT ?? process.env.PORT ?? 8787)
  const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 8787
  return serve({
    fetch: createHostedNodeApp(input.env).fetch,
    port,
    hostname: input.hostname ?? input.env?.HOST ?? process.env.HOST,
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startHostedNodeServer()
}
