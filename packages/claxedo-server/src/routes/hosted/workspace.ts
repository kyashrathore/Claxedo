/**
 * Hosted (Cloudflare Worker) user-hosted workspace control-plane routes.
 *
 * This is the Worker-side adapter over the shared, runtime-neutral logic in
 * `routes/workspace-user-hosted.ts` (the same module the local Node server uses).
 * It imports no disk store, host identity, supervisor, or tunnel.
 *
 * The one genuine behavioural difference from the local server: the host keypair
 * is owned by the CLI, not the server. So register/heartbeat are CLIENT-SIGNED,
 * via a two-step flow:
 *
 *   1. POST /:id/user-hosted/challenge → return a signing challenge. Never
 *      mutates the workspace — registration waits for host proof.
 *   2. CLI signs (workspaceId, hostId, challengeId, nonce) with its local key.
 *   3. POST /:id/user-hosted/register  → verify the signature + record the link
 *      (Convex), THEN register the workspace for sharing, and mint a Host
 *      Tunnel Token. Never starts the tunnel — the CLI does.
 *   4. POST /:id/user-hosted/heartbeat → client-signed; refresh + re-mint HTT.
 *   5. POST /:id/user-hosted/pause     → pause the link in Convex.
 *
 * `GET /:id/connection` is shared with the local server (`userHostedConnectionInfo`).
 */

import { Hono, type Context } from "hono"
import { z } from "zod"
import { anyApi } from "convex/server"
import { hostedSandboxNetworkPolicy } from "@claxedo/sandbox-manager"
import {
  ControlPlaneAuthError,
  controlPlaneAuthConfig,
  controlPlaneAuthErrorBody,
} from "../../authority/auth"
import type { ControlPlaneServices } from "../../authority/services"
import { requireAuthority } from "../../authority/authority"
import { createFixedWindowConnectionRateLimiter, type ConnectionRateLimiter } from "../../authority/rate-limit"
import { newWorkspaceId } from "../../authority/workspace-id"
import {
  requireExecutor,
  requireServiceToken,
} from "../../authority/adapters/convex/workspace-authority/executor"
import {
  apiError,
  captureWorkspaceTelemetry,
  connectionRateLimitError,
  controlPlaneRateLimitError,
  configuredRelayUrl,
  hostTunnelCredential,
  hostedConnectionInfo,
  parsedBody,
  rec,
  signedOrError,
  txt,
  type WorkspaceRouteOptions,
} from "../workspace/user-hosted"
import { sandboxLeaseCapError, type ActiveSandboxLeaseCounter } from "../workspace/runtime-token-guards"
import { normalizeClaxedoRegion } from "../../region"
import { emitSandboxLeaseOpened } from "../../telemetry/metering"
import { recordSandboxLeaseTenant } from "../../telemetry/convex-usage-ledger"
import { productIdentity } from "../../telemetry/product"

// `requireCloudWorkspaceEntitlement` (the D6/B4 paid-capability gate for both
// create and wake) now lives on the shared WorkspaceRouteOptions so the wake
// choke point (workspace-hosted-connection-info.ts) reads the same hook.
//
// The three additions here are hosted-only knobs for `POST /create`, the one
// route in this file that provisions real infrastructure. They are optional, so
// every existing composition keeps type-checking and gets the safe defaults.
export type HostedWorkspaceRouteOptions = WorkspaceRouteOptions & {
  /**
   * Rate limiter for `POST /create` SPECIFICALLY. Deliberately not the shared
   * 120/min control-plane limiter: a heartbeat is a Convex patch, a create is a
   * VM. See `DEFAULT_CREATE_LIMIT` for the number.
   */
  createWorkspaceRateLimiter?: ConnectionRateLimiter
  /**
   * Max concurrently-live sandbox leases per tenant — the caller's org when the
   * token carries one, and always the caller themselves. `0` disables the cap.
   */
  sandboxLeaseCap?: number
  /** Injection seam for the cap's Convex read (tests, alternative authorities). */
  countActiveOrgSandboxLeases?: ActiveSandboxLeaseCounter
  /**
   * Extra hostnames appended to the hosted sandbox egress allowlist.
   *
   * The baseline in `hostedSandboxNetworkPolicy` covers the control plane, the
   * workspace's git host, model providers, and package registries. A
   * deployment that needs anything beyond that — a private registry, a
   * self-hosted model gateway — names it here, so widening the sandbox's
   * reachable surface is an explicit configuration decision rather than a
   * default nobody chose.
   */
  sandboxEgressExtraHosts?: string[]
}

/**
 * `POST /create` requests per minute, per caller.
 *
 * Sized against what the operation COSTS, not against what the transport can
 * take. Every accepted create clones a repo into a freshly provisioned sandbox
 * VM — seconds to minutes of cold start, billed. Nothing legitimate approaches
 * this: the app creates one workspace per explicit user action, and even an
 * impatient human retrying a failed create stays in low single digits per
 * minute. Five leaves room for retries and double-submits while cutting the
 * worst case a single isolate can provision from the 120/min control-plane
 * class to 5/min — a 24x reduction in the cost of a create flood.
 */
const DEFAULT_CREATE_LIMIT = 5
const DEFAULT_CREATE_WINDOW_MS = 60_000

/**
 * Concurrently-live sandbox leases per tenant.
 *
 * This is a blast-radius bound, not a business quota — the billing entitlement
 * gate is what expresses "what did you pay for". At roughly one live sandbox
 * per actively-working seat plus headroom for background/agent workspaces, 25
 * comfortably covers a ~10-seat team without ever being reached in normal use,
 * while capping what a compromised token or a runaway client can leave running
 * at 25 VMs instead of "as many as it can ask for". Deployments that need a
 * different number set `sandboxLeaseCap`.
 *
 * The same number bounds a personal account, where the tenant is the single
 * signing subject rather than an org — generous for one human, and still a
 * bound, which is what a stolen personal token had none of before.
 */
const DEFAULT_SANDBOX_LEASE_CAP = 25

const leaseApi = anyApi as unknown as {
  sandboxLeases: { countActiveForOrg: unknown }
}

/**
 * Default lease counter: the `sandboxLeases.countActiveForOrg` service query on
 * the same Convex deployment the rest of the control plane uses. Resolves url +
 * service token at CALL time (matching `recordSandboxLeaseTenant`) so a Worker
 * that gains its secret after boot starts enforcing without a redeploy.
 *
 * Returns `undefined` — "could not count" — rather than throwing. See
 * `sandboxLeaseCapError` for why that is safe.
 */
const convexActiveLeaseCounter: ActiveSandboxLeaseCounter = async ({ orgId, ownerSubject }) => {
  try {
    const executor = requireExecutor({}, undefined, { allowUnsigned: true })
    const result = await executor.query(leaseApi.sandboxLeases.countActiveForOrg, {
      // Spread conditionally rather than passing `undefined`: both scopes are
      // optional args on the Convex side and at least one is required, so an
      // omitted key and a present-but-empty one must stay distinguishable.
      // Passing both is a union — a lease matching both is counted once.
      ...(orgId ? { org_id: orgId } : {}),
      ...(ownerSubject ? { owner_subject: ownerSubject } : {}),
      service_token: requireServiceToken(),
    })
    const active = rec(result)?.active
    return typeof active === "number" ? active : undefined
  } catch {
    return undefined
  }
}

const refreshConnectionBody = z
  .object({
    previousJti: z.string().optional(),
  })
  .strict()

// The CLI owns the host identity, so register accepts the host's public key and
// the client-produced signature over the challenge nonce.
const registerBody = z
  .object({
    hostId: z.string(),
    publicKey: z.string(),
    challengeId: z.string(),
    signature: z.string(),
    displayName: z.string().optional(),
    ttlMs: z.number().optional(),
    projectId: z.string().optional(),
    repoUrl: z.string().optional(),
    repoName: z.string().optional(),
    gitBranch: z.string().optional(),
    remoteDirectory: z.string().optional(),
  })
  .strict()

const challengeBody = z
  .object({
    hostId: z.string(),
    displayName: z.string().optional(),
    projectId: z.string().optional(),
    repoUrl: z.string().optional(),
    repoName: z.string().optional(),
    gitBranch: z.string().optional(),
  })
  .strict()

const createCloudBody = z
  .object({
    projectId: z.string().optional(),
    projectName: z.string().optional(),
    workspaceName: z.string().optional(),
    repoUrl: z.string().optional(),
    repoName: z.string().optional(),
    gitBranch: z.string().optional(),
    remoteDirectory: z.string().optional(),
  })
  .strict()

const heartbeatBody = z
  .object({
    hostId: z.string(),
    signature: z.string(),
    ttlMs: z.number().optional(),
  })
  .strict()

const pauseBody = z
  .object({
    hostId: z.string().optional(),
    paused: z.boolean().default(true),
  })
  .strict()

function missingBearer() {
  return controlPlaneAuthErrorBody(
    new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required"),
  )
}

// Convex throws typed-message errors; `workspace_backing_conflict` means the
// caller tried to register a cloud workspace as user-hosted local → 409.
function isWorkspaceBackingConflict(err: unknown) {
  return err instanceof Error && err.message.includes("workspace_backing_conflict")
}

function workspaceBackingConflictBody() {
  return {
    error: apiError(
      "workspace_backing_conflict",
      "Workspace is cloud-backed and cannot be registered as a user-hosted local workspace",
    ),
  }
}

function regionalHostTunnel(
  options: HostedWorkspaceRouteOptions,
  source: unknown,
  hostTunnel: Awaited<ReturnType<typeof hostTunnelCredential>>,
) {
  if (!hostTunnel) return
  const row = rec(source)
  const homeRegion = normalizeClaxedoRegion(txt(row?.home_region) ?? txt(row?.homeRegion), options.defaultHomeRegion)
  const relayUrl = configuredRelayUrl(options, homeRegion)
  return {
    ...hostTunnel,
    homeRegion,
    ...(relayUrl ? { relayUrl } : {}),
  }
}

export function HostedWorkspaceRoutes(services?: ControlPlaneServices, options: HostedWorkspaceRouteOptions = {}) {
  const connectionRateLimiter = options.connectionRateLimiter ?? createFixedWindowConnectionRateLimiter()
  const controlPlaneRateLimiter =
    options.controlPlaneRateLimiter ??
    createFixedWindowConnectionRateLimiter({
      limit: 120,
      windowMs: 60_000,
    })
  // Its OWN bucket, not a slice of the 120/min one: creates must not be able to
  // consume the budget every other control-plane call shares, and the shared
  // budget must not be able to hide a create flood.
  const createWorkspaceRateLimiter =
    options.createWorkspaceRateLimiter ??
    createFixedWindowConnectionRateLimiter({
      limit: DEFAULT_CREATE_LIMIT,
      windowMs: DEFAULT_CREATE_WINDOW_MS,
    })
  const sandboxLeaseCap = options.sandboxLeaseCap ?? DEFAULT_SANDBOX_LEASE_CAP
  const countActiveOrgSandboxLeases = options.countActiveOrgSandboxLeases ?? convexActiveLeaseCounter

  const authOptions = () => ({
    ...options,
    authConfig: options.authConfig ?? controlPlaneAuthConfig(),
    requireSigned: true as const,
  })
  const connectionResponse = async (c: Context, previousJti?: string) => {
    const workspaceId = c.req.param("id")
    const authResult = await signedOrError(c.req.raw, authOptions(), services)
    if ("error" in authResult) return c.json(authResult.error, authResult.status as 401 | 403 | 503)
    const auth = authResult.auth
    if (!auth) return c.json(missingBearer(), 401)
    try {
      // Both checks happen up front (before any Convex call) so a flood is
      // rejected cheaply. The control-plane limiter (the same 120/min class
      // heartbeats use) caps TOTAL connection requests: the mint budget below
      // is REFUNDED for provisioning responses (a provisioning poll never
      // mints; cold starts poll every ~2s), so without this outer cap a
      // flooding client could drive unbounded Convex reads.
      const controlPlaneLimit = await controlPlaneRateLimitError(services, controlPlaneRateLimiter, auth, {
        key: `connection:${workspaceId}`,
        action: "workspace.connection.denied",
        workspaceId,
      })
      if (controlPlaneLimit) return c.json(controlPlaneLimit.body, controlPlaneLimit.status)
      const rateLimit = await connectionRateLimitError(services, connectionRateLimiter, auth, workspaceId)
      if (rateLimit) return c.json(rateLimit.body, rateLimit.status)
      const result = await hostedConnectionInfo(services, options, auth, workspaceId, previousJti)
      if ("error" in result)
        return c.json({ error: result.error }, result.status as 400 | 401 | 402 | 403 | 409 | 503)
      if ("status" in result.connection && result.connection.status === "provisioning") {
        connectionRateLimiter.refund?.({ userId: auth.user.subject, workspaceId })
      }
      return c.json(result.connection)
    } catch (err) {
      if (err instanceof ControlPlaneAuthError)
        return c.json(controlPlaneAuthErrorBody(err), err.status as 400 | 401 | 403 | 503)
      throw err
    }
  }

  return (
    new Hono()
      // Workspace LIST. Mirrors the LOCAL handler (routes/workspace.ts GET "/")
      // for shape: signed when access is cloud|user-hosted, returns
      // { workspaces: [...] }, filtered to user-hosted rows when access=user-hosted.
      // The hosted control plane has no local projects list, so the unsigned /
      // no-access case returns an empty list (NOT the local listProjects()).
      .get("/", async (c) => {
        const access = c.req.query("access")
        const requireSigned = access === "cloud" || access === "user-hosted"
        const authResult = await signedOrError(
          c.req.raw,
          {
            ...authOptions(),
            requireSigned,
          },
          services,
        )
        if ("error" in authResult) return c.json(authResult.error, authResult.status as 401 | 403 | 503)
        if (authResult.auth && requireSigned) {
          const auth = authResult.auth
          try {
            const authority = requireAuthority(services)
            await authority.usersMe(auth)
            const rateLimit = await controlPlaneRateLimitError(services, controlPlaneRateLimiter, auth, {
              key: `workspaces.list:${access}`,
              action: "workspaces.list.denied",
            })
            if (rateLimit) return c.json(rateLimit.body, rateLimit.status)
            const workspaces = await authority.listWorkspaces(auth)
            return c.json({
              workspaces:
                Array.isArray(workspaces) && access === "user-hosted"
                  ? workspaces.filter((item) => rec(item)?.access === "user-hosted")
                  : workspaces,
            })
          } catch (err) {
            if (err instanceof ControlPlaneAuthError)
              return c.json(controlPlaneAuthErrorBody(err), err.status as 400 | 401 | 403 | 503)
            throw err
          }
        }
        return c.json({ workspaces: [] })
      })
      // Workspace RESOLVE. The app resolves a directory/workspaceId to a runtime
      // snapshot before reading runtime resources. The hosted central had no such
      // route, so the call fell through to the Pages SPA fallback (200 index.html)
      // and crashed `readJson` ("Unexpected token '<'"), silently breaking session
      // creation. This route exists so the call stays on the WORKER (never Pages)
      // and resolves cheaply. It deliberately returns `null` — the app's documented
      // "no central runtime snapshot" signal — rather than synthesizing one from
      // Convex per request: the workspace kind/directory the app needs already
      // comes from the signed inventory (workspaces.list), and a per-request Convex
      // round-trip here turned the app's resolve polling into a request storm. Fast
      // + side-effect-free keeps the resolve loop quiet and lets the session create
      // proceed over the relay using the inventory-known workspace.
      .get("/resolve", (c) => c.json(null))
      // Cloud workspace creation on the HOSTED control plane. The local Node
      // server's `routes/workspace.ts` `/create` is fat (filesystem config,
      // credential registry, telemetry) and Node-only; the hosted path is thin:
      // record the cloud workspace in Convex and kick off provisioning through
      // the composed SandboxManager (which drives the native edge
      // SandboxDriver, e.g. Cloudflare). Provisioning progress is observed via
      // `/:id/connection` polling, so this returns as soon as the doc exists.
      .post("/create", async (c) => {
        const authResult = await signedOrError(c.req.raw, authOptions(), services)
        if ("error" in authResult) return c.json(authResult.error, authResult.status as 401 | 403 | 503)
        const auth = authResult.auth
        if (!auth) return c.json(missingBearer(), 401)

        // FIRST, before the body is even read, and long before the Convex
        // round-trip or `sandboxManager.ensure` — same reasoning as the
        // connection handler above: a flood must be rejected while it is still
        // cheap to reject. This route is the only one in the file that
        // provisions real infrastructure, so it was also the only one with no
        // limiter at all before the 2026-07-27 security review (§4.3).
        //
        // Keyed on the caller alone (`workspaces.create`) because no workspace
        // exists yet — the same shape the workspace LIST handler uses.
        const createLimit = await controlPlaneRateLimitError(services, createWorkspaceRateLimiter, auth, {
          key: "workspaces.create",
          action: "workspace.create.denied",
        })
        if (createLimit) return c.json(createLimit.body, createLimit.status)

        const parsed = parsedBody(createCloudBody, await c.req.json().catch(() => ({})))
        if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status)
        const body = parsed.body

        const sandboxManager = services?.sandbox.sandboxManager
        if (!sandboxManager) {
          // No sandbox driver composed (no native driver credentials, or the
          // explicitly selected driver is missing backend env). Fail with a
          // precise, actionable error instead
          // of a 404 — cloud is genuinely unavailable, not "route not found".
          return c.json(
            {
              error: apiError(
                "sandbox_driver_unavailable",
                "No cloud sandbox driver is configured on this control plane",
              ),
            },
            503,
          )
        }
        const repoUrl = body.repoUrl?.trim()
        if (!repoUrl) {
          return c.json(
            { error: apiError("cloud_workspace_source_required", "repoUrl is required for hosted cloud workspaces") },
            400,
          )
        }

        // D6/B4 entitlement gate — BEFORE any workspace doc exists. Fail-closed:
        // free tier → 402 (typed billing_entitlement_required), billing mirror
        // unreadable → 503; either way nothing is created.
        if (options.requireCloudWorkspaceEntitlement) {
          const denied = await options.requireCloudWorkspaceEntitlement(auth)
          if (denied) return c.json(denied.body as never, denied.status)
        }

        // Timestamp-prefixed + 80 bits of cryptographic randomness. The old
        // `ws_${Date.now().toString(36)}` was guessable inside any plausible
        // creation window (security review Chain A) and published its own
        // creation time.
        const workspaceId = newWorkspaceId()
        const projectId = body.projectId?.trim() || workspaceId
        const displayName =
          body.workspaceName?.trim() || body.projectName?.trim() || body.repoName?.trim() || workspaceId
        const directory = body.remoteDirectory?.trim() || "/workspace"
        const homeRegion = normalizeClaxedoRegion(undefined, options.defaultHomeRegion)

        try {
          const authority = requireAuthority(services)
          // Per-tenant CONCURRENT sandbox cap, read from durable Convex state.
          // The rate limiter above bounds requests per minute inside ONE
          // isolate; this bounds how many sandboxes the caller can have running
          // at once, and it is the only one of the two that survives an isolate
          // boundary (§6.7 — the limiters are per-isolate in-memory Maps). A
          // slow drip that never trips a rate limit still stops here.
          //
          // Keyed on `auth.user.orgId` — the Clerk org claim — because that is
          // the id space `sandboxLeases.recordTenant` stamps onto the lease row
          // below (and the same one the metering events key on). Using the
          // authority's internally-resolved org id here would compare two
          // different id spaces and count zero forever.
          //
          // The org claim is the OPTIONAL half of the scope. The other half,
          // the caller's subject, is not passed: `sandboxLeaseCapError` reads
          // it off this same verified `auth`, so it cannot be forgotten here
          // and the cap binds for a personal account exactly as it does for an
          // org — see the stamping call below, which writes the matching
          // `owner_subject`.
          const leaseCapped = await sandboxLeaseCapError(services, auth, {
            orgId: auth.user.orgId,
            cap: sandboxLeaseCap,
            action: "workspace.create.denied",
            countActiveLeases: countActiveOrgSandboxLeases,
          })
          if (leaseCapped) return c.json(leaseCapped.body, leaseCapped.status)
          await authority.usersMe(auth)
          await authority.createCloudWorkspace(auth, {
            workspaceId,
            projectId,
            displayName,
            repoUrl,
            ...(body.repoName?.trim() ? { repoName: body.repoName.trim() } : {}),
            ...(body.gitBranch?.trim() ? { gitBranch: body.gitBranch.trim() } : {}),
            homeRegion,
          })
        } catch (err) {
          if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
          throw err
        }

        // W5 sandbox-compute metering (metric spec §4.2): the create path is the
        // one lease-open site that holds a signed tenant, so the opening event is
        // emitted here rather than inside the manager. `started_at` is stamped
        // before `ensure` so the interval covers the cold start the user is
        // actually paying for. This shell only serves the hosted plane, which
        // fixes deployment_mode; a personal-account token carries no org claim
        // and falls through to the ops plane rather than inventing an org id.
        const leaseStartedAt = Date.now()
        const leaseIdentity = productIdentity(auth, { surface: "workspace", deployment_mode: "cloud" })
        emitSandboxLeaseOpened({
          identity: leaseIdentity,
          sink: services?.telemetry,
          lease: {
            workspace_id: workspaceId,
            driver: services?.sandbox.defaultDriver ?? "unknown",
            started_at: leaseStartedAt,
          },
          systemReason: "workspace_create_without_org_claim",
        })

        const source = {
          kind: "git" as const,
          repoUrl,
          ...(body.gitBranch?.trim() ? { branch: body.gitBranch.trim() } : {}),
        }

        // Kick off provisioning. The lease state machine + driver.ensureHost are
        // idempotent and re-polled by the app via /connection, so this is
        // fire-and-forget: a slow cold-start must not block the create response.
        void sandboxManager
          .ensure(workspaceId, {
            homeRegion,
            labels: {
              projectId,
            },
            workspaceRoot: directory,
            source,
            // Security review 2026-07-27 §6.14 — this is the hosted, multi-tenant
            // create path, so the sandbox it provisions runs agent-authored code
            // over someone's private checkout. `net` was omitted here, and an
            // omitted policy means allow-all: every hosted sandbox was running
            // with the open internet available to it.
            //
            // The policy is now ALWAYS supplied here. What reaches the driver is
            // the manager's call, per the owner directive of 2026-07-28 —
            // "enforce where we can and document where we can't" — resolved by
            // `sandboxEgressDisposition`:
            //
            //  - a driver that can enforce (daytona, vercel) is handed the
            //    allowlist verbatim and contains the sandbox;
            //  - a driver declaring `egressControl: "none"` (cloudflare — which
            //    the hosted auto-selection prefers — plus exe, the fetch bridge,
            //    docker, modal, box) has it WITHHELD rather than handed down, and
            //    the sandbox comes up with unrestricted egress. Withholding is
            //    what keeps the drivers that throw on a restricted policy from
            //    seeing one, and stops the ones that silently drop it from
            //    pretending. That is a real exposure, so it is loud and never
            //    silent: the manager warns, and the hosted composition also
            //    emits `sandbox.egress_unenforced` per create
            //    (`sandboxEgressUnenforcedSink`). See
            //    `public-docs/sandbox-egress.md` for the operator-facing matrix.
            //
            // So provisioning is no longer refused for an uncontained driver.
            // Only `sandbox_egress_policy_unenforceable` still fails closed, and
            // it is the sole reason left that reaches the refusal branch below.
            //
            // The allowlist is deliberately assembled from this request (its own
            // relay/control plane, the one git host it clones from) plus the
            // model-provider and package-registry floor. See
            // `hostedSandboxNetworkPolicy` for what is excluded and why.
            net: hostedSandboxNetworkPolicy({
              controlPlane: [configuredRelayUrl(options, homeRegion), new URL(c.req.url).origin],
              source,
              ...(options.sandboxEgressExtraHosts ? { extraHosts: options.sandboxEgressExtraHosts } : {}),
            }),
          })
          // The lease row exists once `ensure` has acquired it, so the tenant is
          // stamped here rather than before: the sandbox manager's acquire port
          // carries a workspace and a driver but no org, and this is the nearest
          // point that holds both the verified tenant and a lease to attach it
          // to. Metering attribution never gates provisioning, so a deployment
          // with no Convex authority configured simply records nothing.
          .then((result) => {
            // Since the 2026-07-28 inversion the only refusal that can land here
            // is `sandbox_egress_policy_unenforceable`: a driver that DOES
            // enforce egress, handed an encoding it cannot express (hosts-only
            // vercel and a CIDR-only policy). An `egressControl: "none"` driver
            // no longer arrives — it provisions uncontained and warns instead.
            // The prefix match is kept deliberately broad so any future
            // `sandbox_egress_*` refusal surfaces rather than vanishing.
            //
            // It is a DEPLOYMENT fault, not a transient one: no retry helps and
            // no sandbox will ever come up. `ensure` is fire-and-forget, so
            // without this the only signal an operator gets is a workspace that
            // provisions forever. There is also no lease to attribute, so
            // metering is skipped.
            if (result.status === "unavailable" && result.error?.startsWith("sandbox_egress_")) {
              captureWorkspaceTelemetry({
                services,
                auth,
                event: "workspace.create.sandbox_egress_refused",
                workspaceId,
                properties: {
                  reason: result.error,
                  driver: services?.sandbox.defaultDriver ?? "unknown",
                },
              })
              return
            }
            // Two independent stamps, matching `recordTenant`'s two:
            //
            //  - `owner_subject` ALWAYS, because it is what the concurrency cap
            //    counts on and every signed request carries a subject. This
            //    used to be gated behind `leaseIdentity`, so a personal-account
            //    create stamped nothing, its lease was unattributed, and the
            //    cap could not bind for it — the hole this closes.
            //  - the W5 metering pair only when a signed org claim produced a
            //    `leaseIdentity`. A usage fact keyed on a fabricated org (say
            //    `personal:<subject>`) would corrupt every per-org aggregate
            //    downstream, which is why the owner is a separate column rather
            //    than an org id we invent to make the count work.
            void recordSandboxLeaseTenant({
              workspace_id: workspaceId,
              owner_subject: auth.user.subject,
              ...(leaseIdentity
                ? { metering: { org_id: leaseIdentity.org_id, user_id: leaseIdentity.user_id } }
                : {}),
            })
          })
          .catch(() => undefined)

        return c.json({ workspaceId, directory })
      })
      .get("/:id/connection", (c) => connectionResponse(c))
      .post("/:id/connection", async (c) => {
        const body = parsedBody(refreshConnectionBody, await c.req.json().catch(() => ({})))
        if (!body.ok) return c.json({ error: body.error }, body.status)
        return connectionResponse(c, body.body.previousJti)
      })
      .post("/:id/connection/refresh", async (c) => {
        const body = parsedBody(refreshConnectionBody, await c.req.json().catch(() => ({})))
        if (!body.ok) return c.json({ error: body.error }, body.status)
        return connectionResponse(c, body.body.previousJti)
      })
      .post("/:id/user-hosted/challenge", async (c) => {
        const workspaceId = c.req.param("id")
        const authResult = await signedOrError(c.req.raw, authOptions(), services)
        if ("error" in authResult) return c.json(authResult.error, authResult.status as 401 | 403 | 503)
        const auth = authResult.auth
        if (!auth) return c.json(missingBearer(), 401)
        const parsed = parsedBody(challengeBody, await c.req.json().catch(() => ({})))
        if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status)
        const body = parsed.body
        try {
          const rateLimit = await controlPlaneRateLimitError(services, controlPlaneRateLimiter, auth, {
            key: `userHosted.challenge:${workspaceId}`,
            action: "local_host_link.challenge.denied",
            workspaceId,
          })
          if (rateLimit) return c.json(rateLimit.body, rateLimit.status)
          const authority = requireAuthority(services)
          await authority.usersMe(auth)
          // Challenge issuance must NOT mutate the workspace: registering it for
          // sharing happens in /register, only AFTER the host proved its key.
          const challenge = await authority.createLocalHostLinkChallenge(auth, { workspaceId, hostId: body.hostId })
          return c.json({
            challenge: {
              challengeId: challenge.challenge_id,
              nonce: challenge.nonce,
              expiresAt: challenge.expires_at,
            },
          })
        } catch (err) {
          if (isWorkspaceBackingConflict(err)) return c.json(workspaceBackingConflictBody(), 409)
          if (err instanceof ControlPlaneAuthError)
            return c.json(controlPlaneAuthErrorBody(err), err.status as 400 | 401 | 403 | 503)
          throw err
        }
      })
      .post("/:id/user-hosted/register", async (c) => {
        const workspaceId = c.req.param("id")
        const authResult = await signedOrError(c.req.raw, authOptions(), services)
        if ("error" in authResult) return c.json(authResult.error, authResult.status as 401 | 403 | 503)
        const auth = authResult.auth
        if (!auth) return c.json(missingBearer(), 401)
        const parsed = parsedBody(registerBody, await c.req.json().catch(() => ({})))
        if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status)
        const body = parsed.body
        try {
          const rateLimit = await controlPlaneRateLimitError(services, controlPlaneRateLimiter, auth, {
            key: `userHosted.register:${workspaceId}`,
            action: "local_host_link.register.denied",
            workspaceId,
          })
          if (rateLimit) return c.json(rateLimit.body, rateLimit.status)
          const authority = requireAuthority(services)
          await authority.usersMe(auth)
          // The CLI signed the challenge with its own private key. The hosted
          // control plane only records the link — it never holds the host key.
          // Convex verifies the host signature here; nothing about the workspace
          // is mutated until that proof succeeds.
          const link = await authority.registerLocalHostLink(auth, {
            workspaceId,
            hostId: body.hostId,
            publicKey: body.publicKey,
            challengeId: body.challengeId,
            signature: body.signature,
            ...(body.displayName ? { displayName: body.displayName } : {}),
            ...(body.ttlMs === undefined ? {} : { ttlMs: body.ttlMs }),
          })
          // Only after host proof: register/refresh the workspace for sharing.
          const workspace = await authority.registerLocalForSharing(auth, {
            workspaceId,
            displayName: body.displayName ?? workspaceId,
            ...(options.defaultHomeRegion ? { homeRegion: options.defaultHomeRegion } : {}),
            ...(body.projectId ? { projectId: body.projectId } : {}),
            ...(body.repoUrl ? { repoUrl: body.repoUrl } : {}),
            ...(body.repoName ? { repoName: body.repoName } : {}),
            ...(body.gitBranch ? { gitBranch: body.gitBranch } : {}),
            ...(body.remoteDirectory ? { remoteDirectory: body.remoteDirectory } : {}),
          })
          await authority.auditAllow(auth, {
            action: "local_host_link.enabled",
            workspaceId,
            metadata: { hostId: body.hostId },
          })
          captureWorkspaceTelemetry({
            services,
            auth,
            event: "local_host_link.enabled",
            workspaceId,
            properties: { hostId: body.hostId },
          })
          // Mint the Host Tunnel Token and return it. The CLI/local runtime starts
          // and owns the tunnel — the hosted control plane never does.
          const hostTunnel = await hostTunnelCredential(options, auth, { hostId: body.hostId, workspaceId })
          return c.json({
            workspace,
            localHostLink: link,
            hostTunnel: regionalHostTunnel(options, workspace, hostTunnel),
          })
        } catch (err) {
          if (isWorkspaceBackingConflict(err)) return c.json(workspaceBackingConflictBody(), 409)
          if (err instanceof ControlPlaneAuthError)
            return c.json(controlPlaneAuthErrorBody(err), err.status as 400 | 401 | 403 | 503)
          throw err
        }
      })
      .post("/:id/user-hosted/heartbeat", async (c) => {
        const workspaceId = c.req.param("id")
        const authResult = await signedOrError(c.req.raw, authOptions(), services)
        if ("error" in authResult) return c.json(authResult.error, authResult.status as 401 | 403 | 503)
        const auth = authResult.auth
        if (!auth) return c.json(missingBearer(), 401)
        const parsed = parsedBody(heartbeatBody, await c.req.json().catch(() => ({})))
        if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status)
        const body = parsed.body
        try {
          // Rate limit FIRST (before any Convex call), keyed only on caller +
          // workspace: a client-supplied hostId must not open a fresh bucket.
          const rateLimit = await controlPlaneRateLimitError(services, controlPlaneRateLimiter, auth, {
            key: `hostPresence.refresh:${workspaceId}`,
            action: "hostPresence.refresh.denied",
            workspaceId,
          })
          if (rateLimit) return c.json(rateLimit.body, rateLimit.status)
          const authority = requireAuthority(services)
          await authority.usersMe(auth)
          // Client-signed: the signature is produced by the CLI, not the server.
          const link = await authority.heartbeatLocalHostLink(auth, {
            workspaceId,
            hostId: body.hostId,
            signature: body.signature,
            ...(body.ttlMs === undefined ? {} : { ttlMs: body.ttlMs }),
          })
          const hostTunnel = await hostTunnelCredential(options, auth, { hostId: body.hostId, workspaceId })
          if (hostTunnel)
            return c.json({ localHostLink: link, hostTunnel: regionalHostTunnel(options, link, hostTunnel) })
          return c.json(link)
        } catch (err) {
          if (err instanceof ControlPlaneAuthError)
            return c.json(controlPlaneAuthErrorBody(err), err.status as 400 | 401 | 403 | 503)
          throw err
        }
      })
      .post("/:id/user-hosted/pause", async (c) => {
        const workspaceId = c.req.param("id")
        const authResult = await signedOrError(c.req.raw, authOptions(), services)
        if ("error" in authResult) return c.json(authResult.error, authResult.status as 401 | 403 | 503)
        const auth = authResult.auth
        if (!auth) return c.json(missingBearer(), 401)
        const parsed = parsedBody(pauseBody, await c.req.json().catch(() => ({})))
        if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status)
        const body = parsed.body
        try {
          // Pause was the other mutating route with no limiter. It writes to
          // Convex and audits on every call, so an unthrottled loop is a Convex
          // write amplifier even though it provisions nothing.
          const rateLimit = await controlPlaneRateLimitError(services, controlPlaneRateLimiter, auth, {
            key: `userHosted.pause:${workspaceId}`,
            action: "local_host_link.pause.denied",
            workspaceId,
          })
          if (rateLimit) return c.json(rateLimit.body, rateLimit.status)
          const authority = requireAuthority(services)
          await authority.usersMe(auth)
          const result = await authority.pauseLocalHostLink(auth, {
            workspaceId,
            ...(body.hostId ? { hostId: body.hostId } : {}),
            paused: body.paused,
          })
          if (body.paused) {
            await authority.auditAllow(auth, {
              action: "local_host_link.disabled",
              workspaceId,
              metadata: { hostId: body.hostId },
            })
            captureWorkspaceTelemetry({
              services,
              auth,
              event: "local_host_link.disabled",
              workspaceId,
              properties: { hostId: body.hostId },
            })
          }
          return c.json(result)
        } catch (err) {
          if (err instanceof ControlPlaneAuthError)
            return c.json(controlPlaneAuthErrorBody(err), err.status as 400 | 401 | 403 | 503)
          throw err
        }
      })
  )
}
