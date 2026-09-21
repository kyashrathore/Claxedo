/**
 * Hosted workspace routes.
 *
 * Sharing a LOCAL workspace runs on machine-wide enrollment: the OWNER
 * assigns the workspace to one of their enrolled hosts
 * (`workspace/host-assignment-handlers.ts`, mounted here), the machine's consent
 * and liveness ride the enrollment heartbeat (`routes/hosted/host-enrollment.ts`),
 * and routing requires assignment AND acked set AND a live lease. There is no
 * per-workspace challenge or signature — that grain is retired.
 *
 * `GET /:id/connection` is shared with the local server (`hostTunnelConnectionInfo`).
 */

import { Hono, type Context } from "hono"
import { routeParam } from "@claxedo/helpers/route-param"
import { z } from "zod"
import { hostedSandboxNetworkPolicy } from "@claxedo/sandbox-manager"
import { admittedRepoUrl, type RepoAddressResolver } from "@claxedo/sandbox-contract"
import { dohAddressResolver } from "@claxedo/server-core/agent-plugins/mcp/dns-resolver"
import {
  ControlPlaneAuthError,
  controlPlaneAuthErrorBody,
} from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServices } from "../../authority/services"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import { createFixedWindowConnectionRateLimiter, type ConnectionRateLimiter } from "../../platform/auth/rate-limit"
import { newWorkspaceId } from "../../platform/auth/workspace-id"
import { keepAlivePastResponse } from "@claxedo/server-core/platform/http/background-work"
import { hostedConnectionInfo, hostedConnectionStatus } from "../../connections/hosted-connection-info"
import { apiError, captureWorkspaceTelemetry, configuredRelayUrl, missingBearerBody, parsedBody, signedOrError, type WorkspaceRouteOptions } from "../../workspace/route-support"
import { asRecord } from "@claxedo/helpers/guards"
import { isClaxedoError } from "@claxedo/server-core/platform/errors/base"
import { contentfulStatus } from "../../platform/http/status"
import { hostAssignmentHandlers } from "../../workspace/host-assignment-handlers"
import { connectionRateLimitError, controlPlaneRateLimitError } from "../../workspace/runtime-token-guards"
import type { ActiveSandboxLeaseCounter } from "../../workspace/runtime-token-guards"
import { createCloudCreateAdmission, type CloudCreateUsage } from "../../workspace/cloud-create-admission"
import { authenticatedGitHubCloneSource } from "../../workspace/repository-clone"
import { normalizeClaxedoRegion } from "@claxedo/server-core/platform/runtime/region/index"

// `requireCloudWorkspaceEntitlement` (the paid-capability gate for both
// create and wake) now lives on the shared WorkspaceRouteOptions so the wake
// choke point (workspace-hosted-connection-info.ts) reads the same hook.
//
// The three additions here are hosted-only knobs for `POST /create`, the one
// route in this file that provisions real infrastructure. They are optional, so
// every existing composition keeps type-checking and gets the safe defaults.
export type HostedWorkspaceRouteOptions = WorkspaceRouteOptions & {
  /**
   * Rate limiter for `POST /create` SPECIFICALLY. Deliberately not the shared
   * 120/min control-plane limiter: a heartbeat is an authority patch, a create is a
   * VM. See `DEFAULT_CREATE_LIMIT` for the number.
   */
  createWorkspaceRateLimiter?: ConnectionRateLimiter
  /**
   * Max concurrently-live sandbox leases per tenant — the caller's org when the
   * token carries one, and always the caller themselves. `0` disables the cap.
   */
  sandboxLeaseCap?: number
  /** Injection seam for the cap's the authority read (tests, alternative authorities). */
  countActiveOrgSandboxLeases?: ActiveSandboxLeaseCounter
  /** Product-owned usage side effects; absent in user-deployed core. */
  sandboxUsage?: CloudCreateUsage
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
  /**
   * DNS answers behind a clone hostname, for the admission check a
   * caller-selected `repoUrl` is held to before it is cloned or allowed into
   * the sandbox's egress allowlist. workerd has no `node:dns`, so the default
   * resolves over DNS-over-HTTPS — the same port MCP discovery fills. A name
   * that does not resolve is refused: clone admission fails closed, not open.
   * Tests and compositions without resolver egress supply their own.
   */
  resolveRepoAddresses?: RepoAddressResolver
  /**
   * Non-public clone destinations the operator explicitly permits — a private
   * Git server, named by exact hostname. Pair each entry with
   * `sandboxEgressExtraHosts`: the admission lets the create through, and the
   * egress entry lets the provisioned sandbox actually reach the host.
   */
  privateRepoHosts?: readonly string[]
}

const refreshConnectionBody = z
  .object({
    previousJti: z.string().optional(),
  })
  .strict()

const createCloudBody = z
  .object({
    orgId: z.string().optional(),
    projectId: z.string().optional(),
    projectName: z.string().optional(),
    workspaceName: z.string().optional(),
    repoUrl: z.string().optional(),
    repoName: z.string().optional(),
    gitBranch: z.string().optional(),
    remoteDirectory: z.string().optional(),
    // Connected-repository source (same contract as the local create route):
    // resolve the clone URL + a brokered token through the caller's GitHub
    // connection instead of requiring a public repoUrl. Both or neither.
    connectionId: z.string().optional(),
    repo: z.object({ fullName: z.string() }).optional(),
    // The app's create dialog sends its sandbox-provider choice. The hosted
    // control plane composes ONE driver from env, so the field is accepted and
    // ignored rather than 400ing the shared client on a strict body.
    driver: z.string().optional(),
  })
  .strict()
  .refine((body) => Boolean(body.connectionId) === Boolean(body.repo), {
    message: "connectionId and repo must be provided together",
  })


export function HostedWorkspaceRoutes(services?: ControlPlaneServices, options: HostedWorkspaceRouteOptions = {}) {
  const connectionRateLimiter = options.connectionRateLimiter ?? createFixedWindowConnectionRateLimiter()
  const controlPlaneRateLimiter =
    options.controlPlaneRateLimiter ??
    createFixedWindowConnectionRateLimiter({
      limit: 120,
      windowMs: 60_000,
    })
  // The one create admission — the same object the Tasks cloud-root allocation
  // is handed, so no create path can reach provisioning without it. Its create
  // budget is its own bucket, not a slice of the 120/min one: creates must not
  // be able to consume the budget every other control-plane call shares, and
  // the shared budget must not be able to hide a create flood.
  const createAdmission = createCloudCreateAdmission({
    services,
    rateLimiter: options.createWorkspaceRateLimiter,
    entitlement: options.requireCloudWorkspaceEntitlement,
    leaseCap: options.sandboxLeaseCap,
    countActiveLeases: options.countActiveOrgSandboxLeases,
  })
  // One canonical admission for every repository this route will have a
  // sandbox clone: the `safeRepoUrl` forms, then a destination that is public
  // (or operator-approved) once the name is resolved. Every caller here is
  // signed, so a private answer is reachability into the deployment's network
  // granted by a remote tenant — refused.
  const repoAdmission = {
    resolve: options.resolveRepoAddresses ?? dohAddressResolver((url, init) => fetch(url, init)),
    ...(options.privateRepoHosts ? { privateHosts: options.privateRepoHosts } : {}),
  }
  const hostAssignment = hostAssignmentHandlers(services, options, controlPlaneRateLimiter)

  const authOptions = () => ({
    ...options,
    requireSigned: true as const,
  })
  const connectionResponse = async (c: Context, input: { previousJti?: string; readOnly?: boolean } = {}) => {
    const workspaceId = routeParam(c, "id")
    const authResult = await signedOrError(c.req.raw, authOptions(), services)
    if ("error" in authResult) return c.json(authResult.error, authResult.status)
    const auth = authResult.auth
    if (!auth) return c.json(missingBearerBody(), 401)
    try {
      // Both checks happen up front (before any the authority call) so a flood is
      // rejected cheaply. The control-plane limiter (the same 120/min class
      // heartbeats use) caps TOTAL connection requests: the mint budget below
      // is REFUNDED for provisioning responses (a provisioning poll never
      // mints; cold starts poll every ~2s), so without this outer cap a
      // flooding client could drive unbounded the authority reads.
      const controlPlaneLimit = await controlPlaneRateLimitError(services, controlPlaneRateLimiter, auth, {
        key: `connection:${workspaceId}`,
        action: "workspace.connection.denied",
        workspaceId,
      })
      if (controlPlaneLimit) return c.json(controlPlaneLimit.body, controlPlaneLimit.status)
      const rateLimit = await connectionRateLimitError(services, connectionRateLimiter, auth, workspaceId)
      if (rateLimit) return c.json(rateLimit.body, rateLimit.status)
      // GET is the read: it reports the lease's current state and may mint only
      // off an already-running sandbox. POST is the explicit connect: the only
      // path that runs `sandboxManager.ensure` and so the only one that can
      // start billable compute (P-118).
      const result = input.readOnly
        ? await hostedConnectionStatus(services, options, auth, workspaceId)
        : await hostedConnectionInfo(services, options, auth, workspaceId, new URL(c.req.url).origin, input.previousJti)
      if ("error" in result)
        return c.json({ error: result.error }, result.status)
      // Any status-bearing body (`provisioning`, `stopped`) minted nothing, so
      // the mint budget it consumed goes back.
      if ("status" in result.connection) {
        connectionRateLimiter.refund?.({ userId: auth.user.subject, workspaceId })
      }
      return c.json(result.connection)
    } catch (err) {
      if (err instanceof ControlPlaneAuthError)
        return c.json(controlPlaneAuthErrorBody(err), err.status)
      throw err
    }
  }

  return (
    new Hono()
      // Workspace LIST. Mirrors the LOCAL handler (workspace/routes/index.ts
      // GET "/") for shape: signed when a host is named, returns
      // { workspaces: [...] }, filtered to machine-placed rows on host=machine.
      // The hosted control plane has no local projects list, so the unsigned /
      // no-host case returns an empty list (NOT the local listProjects()).
      .get("/", async (c) => {
        const host = c.req.query("host")
        if (host !== undefined && host !== "machine" && host !== "provisioner") {
          return c.json({ error: apiError("workspace_host_invalid", "workspace host is invalid") }, 400)
        }
        const requireSigned = host !== undefined
        const authResult = await signedOrError(
          c.req.raw,
          {
            ...authOptions(),
            requireSigned,
          },
          services,
        )
        if ("error" in authResult) return c.json(authResult.error, authResult.status)
        if (authResult.auth && requireSigned) {
          const auth = authResult.auth
          try {
            const authority = requireAuthority(services)
            await authority.usersMe(auth)
            const rateLimit = await controlPlaneRateLimitError(services, controlPlaneRateLimiter, auth, {
              key: `workspaces.list:${host}`,
              action: "workspaces.list.denied",
            })
            if (rateLimit) return c.json(rateLimit.body, rateLimit.status)
            const workspaces = await authority.listWorkspaces(auth)
            return c.json({
              workspaces:
                Array.isArray(workspaces) && host === "machine"
                  ? workspaces.filter((item) => asRecord(item)?.backing === "local-worktree")
                  : workspaces,
            })
          } catch (err) {
            if (err instanceof ControlPlaneAuthError)
              return c.json(controlPlaneAuthErrorBody(err), err.status)
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
      // the authority per request: the workspace kind/directory the app needs already
      // comes from the signed inventory (workspaces.list), and a per-request the authority
      // round-trip here turned the app's resolve polling into a request storm. Fast
      // + side-effect-free keeps the resolve loop quiet and lets the session create
      // proceed over the relay using the inventory-known workspace.
      .get("/resolve", (c) => c.json(null))
      // Cloud workspace creation on the HOSTED control plane. The local Node
      // server's `routes/workspace.ts` `/create` is fat (filesystem config,
      // credential registry, telemetry) and Node-only; the hosted path is thin:
      // record the cloud workspace in the authority and kick off provisioning through
      // the composed SandboxManager (which drives the native edge
      // SandboxDriver, e.g. Cloudflare). Provisioning progress is observed via
      // `/:id/connection` polling, so this returns as soon as the doc exists.
      .post("/create", async (c) => {
        const authResult = await signedOrError(c.req.raw, authOptions(), services)
        if ("error" in authResult) return c.json(authResult.error, authResult.status)
        const auth = authResult.auth
        if (!auth) return c.json(missingBearerBody(), 401)

        // Before the body is read and long before the authority round-trip or
        // `sandboxManager.ensure`: a flood must be rejected while it is still
        // cheap to reject. Keyed on the caller alone (`workspaces.create`)
        // because no workspace exists yet.
        const createLimit = await createAdmission.preflight({ kind: "signed", auth })
        if (createLimit) return c.json(createLimit.body, createLimit.status)

        const parsed = parsedBody(createCloudBody, await c.req.json().catch(() => ({})))
        if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status)
        const body = parsed.body

        // Admission for every create, not only one that names a tenant:
        // the authority's own create admission against the organization the
        // workspace would land in, the paid-capability entitlement, and the
        // concurrent-lease cap — the same object the Tasks cloud-root
        // allocation is subject to, so no door reaches a billable sandbox
        // around it.
        const createDenied = await createAdmission.admit(
          { kind: "signed", auth },
          { orgId: body.orgId, projectId: body.projectId },
        )
        if (createDenied) return c.json(createDenied.body, createDenied.status)

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
        let repoUrl = body.repoUrl?.trim()
        if (repoUrl && !(await admittedRepoUrl(repoUrl, repoAdmission))) {
          return c.json(
            { error: apiError("repo_url_invalid", "That is not a repository URL this server can clone") },
            400,
          )
        }
        let provisionRepoUrl = repoUrl
        let provisionSecrets: Array<{ name: string; value: string; hosts: string[]; header?: string }> | undefined
        if (body.connectionId && body.repo) {
          // Same resolution the local create route performs: the connection
          // proves the caller can read the repository and mints the clone
          // token, which rides to the sandbox as a brokered secret — never in
          // the workspace row or the clone URL the authority stores.
          if (!options.connections) {
            return c.json(
              { error: apiError("repository_connections_unavailable", "Repository connections are unavailable") },
              501,
            )
          }
          const access = await options.connections.repositoryForAuth(auth, body.connectionId, body.repo.fullName)
          if (!access.ok) return c.json({ error: apiError(access.code, "Repository connection is not available") }, access.status)
          repoUrl = access.repository.cloneUrl
          if (!(await admittedRepoUrl(repoUrl, repoAdmission))) {
            return c.json(
              { error: apiError("repo_url_invalid", "That is not a repository URL this server can clone") },
              400,
            )
          }
          const source = authenticatedGitHubCloneSource(access.repository.cloneUrl, access.token)
          provisionRepoUrl = source.repoUrl
          provisionSecrets = [source.secret]
        }
        if (!repoUrl || !provisionRepoUrl) {
          return c.json(
            { error: apiError("cloud_workspace_source_required", "repoUrl is required for hosted cloud workspaces") },
            400,
          )
        }

        // A bare timestamp id is guessable inside any plausible creation window
        // and publishes its own creation time; the random suffix is what makes
        // this one unguessable.
        const workspaceId = newWorkspaceId()
        const projectId = body.projectId?.trim() || workspaceId
        const displayName =
          body.workspaceName?.trim() || body.projectName?.trim() || body.repoName?.trim() || workspaceId
        const directory = body.remoteDirectory?.trim() || "/workspace"
        const homeRegion = normalizeClaxedoRegion(undefined, options.defaultHomeRegion)

        try {
          const authority = requireAuthority(services)
          await authority.usersMe(auth)
          // Only a project the caller named is handed to the authority. Without
          // one the authority derives the project from the repository (reusing
          // the org's existing project for that repo, else creating it); a
          // fresh id here would be an unknown project the caller cannot
          // administer, which the D1 authority rightly refuses.
          await authority.createCloudWorkspace(auth, {
            workspaceId,
            ...(body.orgId?.trim() ? { orgId: body.orgId.trim() } : {}),
            ...(body.projectId?.trim() ? { projectId: body.projectId.trim() } : {}),
            displayName,
            repoUrl,
            ...(body.repoName?.trim() ? { repoName: body.repoName.trim() } : {}),
            ...(body.gitBranch?.trim() ? { gitBranch: body.gitBranch.trim() } : {}),
            homeRegion,
          })
        } catch (err) {
          if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
          // A repository already assigned to another project, an
          // organization this product may not address: the authority's answer
          // about the world, which the caller can act on.
          if (isClaxedoError(err)) return c.json({ error: apiError(err.code, err.message) }, contentfulStatus(err.status))
          throw err
        }

        // Sandbox-compute metering: the create path is the
        // one lease-open site that holds a signed tenant, so the opening event is
        // emitted here rather than inside the manager. `started_at` is stamped
        // before `ensure` so the interval covers the cold start the user is
        // actually paying for. This shell only serves the hosted plane, which
        // fixes deployment_mode; a personal-account token carries no org claim
        // and falls through to the ops plane rather than inventing an org id.
        const leaseStartedAt = Date.now()
        options.sandboxUsage?.leaseOpened({
          caller: { kind: "signed", auth },
          workspaceId,
          driver: services?.sandbox.defaultDriver ?? "unknown",
          startedAt: leaseStartedAt,
          ...(services ? { services } : {}),
        })

        const source = {
          kind: "git" as const,
          // The PROVISION url (token via brokered secret for connected repos);
          // the plain `repoUrl` is what the workspace row records.
          repoUrl: provisionRepoUrl,
          ...(body.gitBranch?.trim() ? { branch: body.gitBranch.trim() } : {}),
        }

        // Kick off provisioning. The lease state machine + driver.ensureHost are
        // idempotent and re-polled by the app via /connection, so the response
        // does not wait for it: a slow cold-start must not block the create.
        // It is held open past the response (`waitUntil` on Workers) because
        // workerd cancels detached work with the request, which left the first
        // `ensure` — and the Agent Plugins runtime provisioning behind it — to
        // whichever `/connection` poll came next.
        const runtimeContext = { workspaceId }
        keepAlivePastResponse(c, Promise.resolve()
          .then(async () => {
            const runtimePreparation = await options.prepareRuntime?.(runtimeContext)
            const runtimeSecrets = runtimePreparation?.secrets ?? []
            const result = await sandboxManager.ensure(workspaceId, {
            homeRegion,
            labels: {
              projectId,
            },
            workspaceRoot: directory,
            source,
            ...(runtimePreparation?.env ? { env: runtimePreparation.env } : {}),
            // Clone token for connected private repos — rides the brokered
            // secret channel (fail-closed in the manager for drivers that
            // cannot broker), never labels or env.
            ...((provisionSecrets !== undefined || runtimePreparation?.secrets !== undefined)
              ? { secrets: [...(provisionSecrets ?? []), ...runtimeSecrets] }
              : {}),
            // This is the hosted, multi-tenant create path: the sandbox runs
            // agent-authored code over someone's private checkout, and an
            // omitted `net` means allow-all, so the policy is always supplied.
            // What reaches the driver is the manager's call, resolved by
            // `sandboxEgressDisposition`:
            //
            //  - a driver that can enforce (daytona, vercel) is handed the
            //    allowlist and contains the sandbox;
            //  - a driver declaring `egressControl: "none"` (cloudflare — which
            //    the hosted auto-selection prefers — plus exe, the fetch bridge,
            //    docker, modal, box) has it withheld, and the sandbox comes up
            //    with unrestricted egress. Withholding keeps the drivers that
            //    throw on a restricted policy from seeing one, and stops the ones
            //    that silently drop it from pretending. That exposure is loud:
            //    the manager warns, and the hosted composition emits
            //    `sandbox.egress_unenforced` per create
            //    (`sandboxEgressUnenforcedSink`). `public-docs/sandbox-egress.md`
            //    has the operator-facing matrix.
            //
            // Only `sandbox_egress_policy_unenforceable` fails closed; it is the
            // sole reason that reaches the refusal branch below.
            //
            // The allowlist is assembled from this request (its own relay/control
            // plane, the one git host it clones from) plus the model-provider and
            // package-registry floor. See `hostedSandboxNetworkPolicy` for what
            // is excluded and why.
            net: hostedSandboxNetworkPolicy({
              controlPlane: [configuredRelayUrl(options, homeRegion), new URL(c.req.url).origin],
              source,
              ...(options.sandboxEgressExtraHosts ? { extraHosts: options.sandboxEgressExtraHosts } : {}),
            }),
            })
            return { result, runtimePreparation }
          })
          // The lease row exists once `ensure` has acquired it, so the tenant is
          // stamped here rather than before: the sandbox manager's acquire port
          // carries a workspace and a driver but no org, and this is the nearest
          // point that holds both the verified tenant and a lease to attach it
          // to. Metering attribution never gates provisioning, so a deployment
          // with no workspace authority configured simply records nothing.
          .then(async ({ result, runtimePreparation }) => {
            if (result.status === "ready") await options.provisionRuntime?.(runtimeContext, runtimePreparation)
            // The only refusal that lands here is
            // `sandbox_egress_policy_unenforceable`: a driver that does enforce
            // egress, handed an encoding it cannot express (hosts-only vercel
            // and a CIDR-only policy). The prefix match stays broad so any
            // future `sandbox_egress_*` refusal surfaces rather than vanishing.
            //
            // It is a deployment fault, not a transient one: no retry helps and
            // no sandbox will ever come up. `ensure` is fire-and-forget, so
            // without this the only signal an operator gets is a workspace that
            // provisions forever. There is no lease to attribute, so metering
            // is skipped.
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
            //  - `owner_subject` always, because the concurrency cap counts on it
            //    and every signed request carries a subject; gating it on
            //    `leaseIdentity` left personal-account leases unattributed and
            //    the cap unable to bind.
            //  - the metering pair only when a signed org claim produced a
            //    `leaseIdentity`. A usage fact keyed on a fabricated org (say
            //    `personal:<subject>`) would corrupt every per-org aggregate
            //    downstream, which is why the owner is a separate column rather
            //    than an org id we invent to make the count work.
            await Promise.resolve(options.sandboxUsage?.recordLeaseTenant({ caller: { kind: "signed", auth }, workspaceId })).catch(() => undefined)
          })
          .catch(() => undefined))

        return c.json({ workspaceId, directory })
      })
      .get("/:id/connection", (c) => connectionResponse(c, { readOnly: true }))
      .post("/:id/connection", async (c) => {
        const body = parsedBody(refreshConnectionBody, await c.req.json().catch(() => ({})))
        if (!body.ok) return c.json({ error: body.error }, body.status)
        return connectionResponse(c, { previousJti: body.body.previousJti })
      })
      .post("/:id/connection/refresh", async (c) => {
        const body = parsedBody(refreshConnectionBody, await c.req.json().catch(() => ({})))
        if (!body.ok) return c.json({ error: body.error }, body.status)
        return connectionResponse(c, { previousJti: body.body.previousJti })
      })
      .post("/:id/host-assignment", hostAssignment.assign)
      .delete("/:id/host-assignment", hostAssignment.unassign)
  )
}
