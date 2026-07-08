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
import { ControlPlaneAuthError, controlPlaneAuthConfig, controlPlaneAuthErrorBody } from "../control-plane/auth"
import type { ControlPlaneServices } from "../control-plane/services"
import { requireAuthority } from "../control-plane/authority"
import { createFixedWindowConnectionRateLimiter } from "../control-plane/rate-limit"
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
} from "./workspace-user-hosted"
import { normalizeClaxedoRegion } from "../region"

export type HostedWorkspaceRouteOptions = WorkspaceRouteOptions

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
      if ("error" in result) return c.json({ error: result.error }, result.status as 400 | 403 | 409 | 503)
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

        const workspaceId = `ws_${Date.now().toString(36)}`
        const projectId = body.projectId?.trim() || workspaceId
        const displayName =
          body.workspaceName?.trim() || body.projectName?.trim() || body.repoName?.trim() || workspaceId
        const directory = body.remoteDirectory?.trim() || "/workspace"
        const homeRegion = normalizeClaxedoRegion(undefined, options.defaultHomeRegion)

        try {
          const authority = requireAuthority(services)
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
            source: {
              kind: "git",
              repoUrl,
              ...(body.gitBranch?.trim() ? { branch: body.gitBranch.trim() } : {}),
            },
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
