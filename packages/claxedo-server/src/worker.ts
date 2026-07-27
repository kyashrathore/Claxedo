/**
 * Cloudflare Worker entrypoint for the hosted Claxedo control plane.
 *
 * This is the ONLY module Wrangler bundles as the Worker. It composes hosted
 * services from the Worker's `env` bindings and serves the Worker-safe
 * `hosted-app`, which mounts only the hosted control-plane route set (health,
 * mode, JWKS, device-login, hosted workspace/connection, hosted control,
 * internal relay, hosted sandbox admin) — a different, narrower surface than
 * the local Node server's routes. It imports nothing local: no
 * `@hono/node-server`, no workspace store/supervisor/embedded runtime/tunnel,
 * no SQLite.
 *
 * The local Node server lives in `server.ts` and is unaffected by this file.
 *
 * Observability: error reporting is explicit, not a wrapper. `posthog-node` is
 * on the Worker's forbidden-import list, so exceptions leave over the same
 * fetch transport as analytics (control-plane/worker-telemetry.ts) and every
 * escape route is covered by hand: Hono's `onError` for route throws, the
 * composition guard below for boot failures, and a try/catch around `scheduled`
 * for cron failures. Options come from env bindings via observabilityOptions:
 * absent CLAXEDO_POSTHOG_KEY → no sink is registered at all and the seam stays
 * a clean no-op (no network). Release = git SHA (CLAXEDO_RELEASE, passed by the
 * D11 deploy workflow); events carry unit=worker + deployment_mode.
 */

import type { ExecutionContext, Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { composeHostedControlPlane, HostedWorkerCompositionError, type HostedControlPlane, type HostedWorkerEnv } from "./control-plane/hosted-services"
import { workerErrorCapture } from "./control-plane/worker-telemetry"
import { createHostedApp, type HostedAppOverrides } from "./hosted-app"
import { runScheduledBillingReconciliation } from "./billing/reconcile"
import { reportError, setErrorReporterSink } from "./observability/report"
import { observabilityOptions, type ObservabilityEnv } from "./observability/config"
import { createHostedWorkGraphRuntime } from "./workgraph-host/hosted-runtime"
import { skipOverlappingReconcile } from "./workgraph-host/reconcile-serialize"
import type { WorkGraphReconcileResult } from "./routes/hosted-workgraph-admin"
import {
  createCloudflareSettlementDispatcher,
  dispatchCloudflareSettlement,
  WorkGraphSettler,
  type WorkGraphSettlerNamespace,
} from "./workgraph-host/cloudflare-settlement-dispatcher"
import { WakeLane, type WakeLaneNamespace, type WakeLaneState } from "./wakes-host/wake-lane"
import { LiveSyncRoom, type LiveSyncRoomNamespace } from "./live-sync-room"
import { composeHostedWakes } from "./wakes-host/hosted-wakes"
import { createWakeSettlementDispatcher } from "./wakes-host/wake-settlement-dispatcher"
import { clean } from "./control-plane/adapters/worker/hosted-compose"
import { createHostedDocumentsBackend } from "./documents/hosted-backend"
import { createHostedDocumentRuntimeBroker } from "./documents/hosted-runtime-broker"
import { createHostedLocalDocumentRelay } from "./documents/hosted-local-relay"
import type { R2BucketBinding } from "./documents/hosted-managed"
import type { SignedControlPlaneAuth } from "./control-plane/auth"
import type { DocumentIndexEntry } from "./documents/index-store"

export { WorkGraphSettler }

// W5.1: the per-owner live-sync fan-out Durable Object. Cloudflare instantiates
// DO classes itself, so it must be exported from the Worker entry module and
// bound (LIVE_SYNC_ROOM) + migrated in wrangler.toml. It holds hosted client
// SSE streams and fans nudges POSTed from any isolate; see src/live-sync-room.ts.
export { LiveSyncRoom }

/**
 * The concrete per-lane Durable Object (wakes-v2 U6): binds the generic
 * WakeLane to the hosted wakes composition (Convex store + workgraph_settle
 * sink). Cloudflare instantiates DO classes itself, hence the subclass.
 */
export class ClaxedoWakeLane extends WakeLane {
  constructor(state: WakeLaneState, env: Record<string, unknown>) {
    super(state, env, {
      createWakes: (doEnv, inDoDriver) => composeHostedWakes(doEnv as HostedWorkerEnv, inDoDriver),
    })
  }
}

type WorkerEnv = Record<string, unknown> & {
  WORKGRAPH_SETTLER?: WorkGraphSettlerNamespace
  WAKE_LANE?: WakeLaneNamespace
  LIVE_SYNC_ROOM?: LiveSyncRoomNamespace
  CLAXEDO_WAKES_SETTLEMENT?: string
}

// The Worker has no module-scope env: bindings arrive per invocation, so the
// seam sink is registered on the first fetch/scheduled call and then left
// alone. Registration is skipped entirely when no key is configured — a
// missing sink is report.ts's own no-op path, which keeps the self-host
// promise (no key ⇒ no network) true without a second guard.
let errorReporterRegistered = false

// The capture POST must outlive the response, and only the current invocation
// owns an ExecutionContext. The sink is synchronous (report.ts's contract), so
// the in-flight promise is handed to whichever waitUntil is current.
let currentWaitUntil: ((promise: Promise<unknown>) => void) | undefined

function ensureErrorReporter(env: WorkerEnv): void {
  if (errorReporterRegistered) return
  errorReporterRegistered = true
  const options = observabilityOptions(env as unknown as ObservabilityEnv, "worker")
  if (!options.enabled) return
  const { captureException } = workerErrorCapture(env as unknown as ObservabilityEnv)
  setErrorReporterSink((error, context) => {
    // Product-plane identity when a call site knows it; the ops-plane "system"
    // principal otherwise. An exception with no request behind it (cron, boot)
    // genuinely has no user.
    const distinctId = context.tags.user_id || "system"
    const promise = captureException(error, distinctId, {
      ...options.tags,
      ...context.tags,
      ...context.extra,
    })
    currentWaitUntil?.(promise)
  })
}

let cached: {
  app: Hono
  plane: HostedControlPlane
  workGraphRuntime?: NonNullable<ReturnType<typeof createHostedWorkGraphRuntime>>
  workGraphReconcile?: () => Promise<WorkGraphReconcileResult>
} | undefined

// D9 fail-closed hosted boot: `composeHostedControlPlane` asserts every
// hosted dependency/secret per-piece, and `createHostedApp` asserts the
// explicit deployment mode (CLAXEDO_DEPLOYMENT_MODE=hosted is REQUIRED) plus
// signed-auth/authority presence. Both throw HostedWorkerCompositionError,
// which `fetch` below maps to a 503 for EVERY request — the Worker is down,
// not open, when hosted config is missing.
function buildApp(env: WorkerEnv): Hono {
  if (cached) return cached.app
  const hostedEnv = env as unknown as HostedWorkerEnv
  const plane = composeHostedControlPlane(hostedEnv)
  const workGraphRuntime = createHostedWorkGraphRuntime(hostedEnv, plane.services)
  // Every trigger path (cron, admin route, smoke cycles) shares one per-isolate
  // guard: overlapping reconciles have hung the Workers runtime.
  const workGraphReconcile = workGraphRuntime ? skipOverlappingReconcile(workGraphRuntime.reconcile) : undefined
  // Wakes-path settlement is flag-gated: with
  // CLAXEDO_WAKES_SETTLEMENT=1 and the WAKE_LANE binding, command nudges go
  // durable-wake-first through the per-lane DO; otherwise the proven
  // WorkGraphSettler path stays in charge. Same SettlementDispatcher port
  // either way — hosted.ts cannot tell the difference.
  const wakesSettlementUrl = clean(hostedEnv.CLAXEDO_WORKGRAPH_CONVEX_URL) ?? clean(hostedEnv.CLAXEDO_WORKSPACE_AUTHORITY_URL)
  const wakesSettlementToken = clean(hostedEnv.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN)
  const useWakesSettlement =
    env.CLAXEDO_WAKES_SETTLEMENT === "1" && !!env.WAKE_LANE && !!wakesSettlementUrl && !!wakesSettlementToken
  const documentsBucket = (env as unknown as { CLAXEDO_DOCUMENTS?: R2BucketBinding }).CLAXEDO_DOCUMENTS
  const app = createHostedApp(plane, {
    ...(workGraphReconcile ? { workGraphReconcile } : {}),
    // W5.2: hand the live-sync fan-out DO namespace to the hosted shell so
    // GET /api/claxedo/events (and aliases) hold their client SSE stream in the
    // caller's LiveSyncRoom.
    ...(env.LIVE_SYNC_ROOM ? { liveSyncRoom: env.LIVE_SYNC_ROOM } : {}),
    ...(useWakesSettlement
      ? {
          workGraphSettlementDispatcherForRequest: (waitUntil: (promise: Promise<unknown>) => void) =>
            createWakeSettlementDispatcher({
              namespace: env.WAKE_LANE!,
              waitUntil,
              url: wakesSettlementUrl!,
              serviceToken: wakesSettlementToken!,
            }),
        }
      : env.WORKGRAPH_SETTLER
        ? {
            workGraphSettlementDispatcherForRequest: (waitUntil: (promise: Promise<unknown>) => void) =>
              createCloudflareSettlementDispatcher({ namespace: env.WORKGRAPH_SETTLER!, waitUntil }),
          }
        : {}),
    ...(documentsBucket ? {
      documentsBackend: createHostedDocumentsBackend(documentsBucket, {
        runtime: createHostedDocumentRuntimeBroker(plane.services, env as unknown as NodeJS.ProcessEnv),
        localRelay: createHostedLocalDocumentRelay(plane.services, env as unknown as NodeJS.ProcessEnv),
        resolveSessionWorkspace: async (auth, sessionId) => {
          const value = await plane.services.authority?.resolveSession?.(auth, { sessionId })
          if (!value || typeof value !== "object") throw new Error("Session placement is unavailable")
          const record = value as Record<string, unknown>
          const workspaceId = typeof record.workspace_id === "string" ? record.workspace_id : record.workspaceId
          if (typeof workspaceId !== "string" || !workspaceId) throw new Error("Session placement is unavailable")
          return workspaceId
        },
        resolveLocalWorkspace: async (auth, projectId) => {
          const rows = await plane.services.authority?.listWorkspaces(auth)
          if (!Array.isArray(rows)) throw new Error("Local document installation is unavailable")
          const matches = rows.filter((value): value is Record<string, unknown> => Boolean(
            value && typeof value === "object" &&
            (value as Record<string, unknown>).project_id === projectId &&
            (value as Record<string, unknown>).access === "user-hosted" &&
            (value as Record<string, unknown>).backing === "local-worktree" &&
            typeof (value as Record<string, unknown>).workspace_id === "string",
          ))
          if (matches.length !== 1) throw new Error("Local document installation is unavailable or ambiguous")
          return matches[0]!.workspace_id as string
        },
        listLocalWorkspaces: async (auth) => {
          const rows = await plane.services.authority?.listWorkspaces(auth)
          if (!Array.isArray(rows)) return []
          return rows.flatMap((value) => {
            if (!value || typeof value !== "object") return []
            const workspace = value as Record<string, unknown>
            return workspace.access === "user-hosted" && workspace.backing === "local-worktree" &&
              typeof workspace.workspace_id === "string" && typeof workspace.project_id === "string"
              ? [{ workspaceId: workspace.workspace_id, projectId: workspace.project_id }]
              : []
          })
        },
        reauthorizeJob: createHostedDocumentJobReauthorizer(plane.services),
        env: env as unknown as NodeJS.ProcessEnv,
      }) as unknown as NonNullable<HostedAppOverrides["documentsBackend"]>,
    } : {}),
  })
  // Hono converts route exceptions into 500s internally, so they never reach
  // the entrypoint's own catch — report them here, keeping Hono's default
  // response behavior (HTTPException responses pass through unreported; they
  // are deliberate 4xx/5xx, not error-tracker material). Guarded because tests
  // stub createHostedApp with a bare { fetch } object.
  if (typeof app.onError === "function") {
    app.onError((err, c) => {
      if (err instanceof HTTPException) return err.getResponse()
      reportError(err, {
        tags: { source: "hosted_app_route" },
        extra: { path: new URL(c.req.url).pathname, method: c.req.method },
      })
      console.error(err)
      return c.text("Internal Server Error", 500)
    })
  }
  cached = { app, plane, ...(workGraphRuntime ? { workGraphRuntime } : {}), ...(workGraphReconcile ? { workGraphReconcile } : {}) }
  return app
}

export function createHostedDocumentJobReauthorizer(services: Pick<HostedControlPlane["services"], "authority">) {
  return async (input: {
    auth: SignedControlPlaneAuth
    entry: DocumentIndexEntry
    sessionId: string
    cloudWorkspaceId: string
    localWorkspaceId: string
  }) => {
    const authority = services.authority
    if (!authority) throw new Error("Document job authority is unavailable")
    await authority.authorizeSessionRead(input.auth, {
      sessionId: input.sessionId,
      workspaceId: input.cloudWorkspaceId,
    })
    const local = await authority.openWorkspace(input.auth, { workspaceId: input.localWorkspaceId })
    if (!local.role || !["editor", "admin", "owner"].includes(local.role)) {
      throw new Error("Document job requires current write access")
    }
    if (local.workspace?.org_id !== input.entry.org_id || local.workspace.project_id !== input.entry.project_id) {
      throw new Error("Document job workspace scope changed")
    }
  }
}

function compositionErrorResponse(err: HostedWorkerCompositionError): Response {
  // Fail closed and loud when a required hosted dependency/secret is missing.
  return Response.json(
    { error: { code: err.code, message: err.message } },
    { status: 503 },
  )
}

// Minimal structural type for the Cloudflare Cron Trigger controller so the
// Worker keeps zero new runtime dependencies (same pattern as ExecutionContext
// above, which enters as a type only).
type ScheduledController = { cron: string; scheduledTime: number }

const handler = {
  async fetch(request: Request, env: WorkerEnv, ctx?: ExecutionContext): Promise<Response> {
    ensureErrorReporter(env)
    currentWaitUntil = ctx ? (promise: Promise<unknown>) => ctx.waitUntil(promise) : undefined
    let app: Hono
    try {
      app = buildApp(env)
    } catch (err) {
      if (err instanceof HostedWorkerCompositionError) {
        // A misconfigured hosted deploy is exactly the incident nobody sees
        // without error tracking; one issue groups the whole flood.
        reportError(err, { tags: { source: "worker_composition" } })
        return compositionErrorResponse(err)
      }
      reportError(err, { tags: { source: "worker_boot" } })
      throw err
    }
    try {
      // Pass the ExecutionContext through so routes can `waitUntil` background
      // work (telemetry, lifecycle touch) past the response.
      return await app.fetch(request, env, ctx)
    } catch (err) {
      // Hono's onError already reported anything a route threw; reaching here
      // means the app shell itself failed, which nothing else would record.
      reportError(err, { tags: { source: "worker_fetch" }, extra: { path: new URL(request.url).pathname, method: request.method } })
      throw err
    }
  },

  // A cron invocation has no request and no route handler, so a throw is its
  // ONLY failure signal: this wrapper is the single place a failed cron becomes
  // an issue, and it re-throws so Cloudflare still records the run as failed.
  async scheduled(controller: ScheduledController, env: WorkerEnv, ctx?: ExecutionContext): Promise<void> {
    ensureErrorReporter(env)
    currentWaitUntil = ctx ? (promise: Promise<unknown>) => ctx.waitUntil(promise) : undefined
    try {
      await runScheduled(controller, env, ctx)
    } catch (err) {
      reportError(err, {
        tags: { source: "worker_scheduled", reason: "cron_failed" },
        extra: { cron: controller?.cron ?? "" },
      })
      throw err
    }
  },
}

// D13 reaper, driver-side half (ops floor ADR 016 §4 Decision 3): the Cron
// Trigger in wrangler.toml drives the EXISTING sandbox GC path — a synthetic
// request to the admin route, authorized with the same admin token — so the
// scheduled sweep and the manual break-glass curl exercise the exact same code
// (`sandboxManager.garbageCollect()`, including its telemetry capture). The
// Convex-side half (lease-table sweep) runs in convex/crons.ts. Every failure
// here (missing config, missing token, non-2xx GC) THROWS so the cron
// invocation is recorded as failed — a silently-dead reaper is the failure mode
// this design exists to avoid.
async function runScheduled(controller: ScheduledController, env: WorkerEnv, ctx?: ExecutionContext): Promise<void> {
  // The every-minute staging lane settles only durable WorkGraph control
  // effects (deletion finalization, execution placement) so clients observe
  // command outcomes within their live sync window. The heavier sandbox GC
  // and billing sweeps stay on the 15-minute lane below.
  if (controller?.cron === "* * * * *") {
    buildApp(env)
    const runtime = cached!.workGraphRuntime
    if (!runtime) return
    const tenants = await runtime.listStaleTenants()
    if (tenants.length === 0) return
    if (!env.WORKGRAPH_SETTLER) {
      throw new Error("WorkGraph settlement backstop requires WORKGRAPH_SETTLER")
    }
    if (!ctx) {
      throw new Error("WorkGraph settlement backstop requires a Worker ExecutionContext")
    }
    await Promise.all(tenants.map((tenant) => dispatchCloudflareSettlement(env.WORKGRAPH_SETTLER!, tenant)))
    return
  }
  const hostedEnv = env as unknown as HostedWorkerEnv
  // F17 (adversarial review): the sandbox GC sweep and the billing
  // reconciliation sweep are ISOLATED — a throwing/failing GC pass must not
  // starve the billing sweep (the downgrade-recovery + deleted-org "bills
  // forever" paths). Each runs under its own try/catch; the GC failure is
  // captured and RE-THROWN after billing runs so the cron invocation is still
  // recorded as failed and reported by the scheduled wrapper (a silently-dead
  // reaper is the money leak this design exists to avoid).
  let gcError: unknown
  try {
    const app = buildApp(env)
    const token = hostedEnv.CLAXEDO_RUNTIME_ADMIN_TOKEN?.trim()
    if (!token) {
      throw new Error("Sandbox reconciliation cron requires CLAXEDO_RUNTIME_ADMIN_TOKEN")
    }
    const response = await app.fetch(
      new Request("https://control-plane.cron.internal/internal/sandbox-manager/gc", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }),
      env,
      ctx,
    )
    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      throw new Error(`Sandbox reconciliation cron failed: ${response.status} ${detail}`.trim())
    }
  } catch (err) {
    gcError = err
  }

  // D5 billing reconciliation sweep (ADR 014 §3): re-fetch Polar customer
  // state for orgs the Convex cron flagged as stale and re-apply it through
  // the single writer. Runs INDEPENDENTLY of the GC outcome above. Already
  // throw-free (a billing hiccup pages via reportPaymentError and the Convex
  // flag persists for the next run); wrapped anyway so a future throw here
  // cannot mask the GC failure. No-op when CLAXEDO_POLAR_ACCESS_TOKEN is
  // absent (billing not deployed).
  try {
    await runScheduledBillingReconciliation(hostedEnv)
  } catch (err) {
    reportError(err, { tags: { source: "worker_scheduled", reason: "billing_sweep_failed" } })
  }

  try {
    const app = buildApp(env)
    void app
    await cached!.workGraphReconcile?.()
  } catch (err) {
    reportError(err, { tags: { source: "worker_scheduled", reason: "workgraph_reconcile_failed" } })
    if (!gcError) gcError = err
  }

  // Surface the GC failure now that billing has had its independent run.
  if (gcError) throw gcError
}

export default handler
