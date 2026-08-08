import { Hono } from "hono"
import { z } from "zod"
import { globalWorkspace, isGlobalDirectory } from "../../session/global"
import {
  defaultSandboxDriverID,
  sandboxDriverId,
  sandboxDriverAuth,
} from "@claxedo/sandbox-manager/driver-catalog"
import { isSandboxDriverID } from "@claxedo/sandbox-contract"
import { WORKSPACE_DIR } from "@claxedo/sandbox-manager/defaults"
import { loadUserConfig, sandboxDriverConfig } from "@claxedo/server-core/agent-config/index"
import { type ControlPlaneServices } from "../../authority/services"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import { workspaceBacking } from "../../workspace/store/backing"
import { ensureHostForRepo } from "@claxedo/server-core/sandbox/network/policy"
import {
  deleteWorkspace,
  ensureWorkspace,
  getProjectWorkspace,
  listProjects,
  resolveWorkspace,
  workspaceIdFromDirectoryRef,
  type Workspace,
} from "@claxedo/server-core/workspace/store/index"
import { discardSupervisorSandbox, getSupervisorSandboxStatus } from "../../workspace/supervisor"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { ControlPlaneAuthError, bearerToken, controlPlaneAuthErrorBody } from "@claxedo/server-core/platform/auth/auth"
import { createFixedWindowConnectionRateLimiter } from "../../platform/auth/rate-limit"
import { newWorkspaceId } from "../../platform/auth/workspace-id"
import { apiError, captureWorkspaceTelemetry, parsedBody, rec, signedOrError, type WorkspaceRouteOptions } from "../route-support"
import { controlPlaneRateLimitError } from "../runtime-token-guards"
import { addWorktree, cloneRepo, repoNameFromUrl } from "../git"
import { heartbeatLocalHostLink, pauseLocalHostLink, registerLocalHostLink } from "../local-host-link"
import { openSignedWorkspaceByDirectory, openSignedWorkspaceJson } from "../signed-access"
import { workspaceConnectionRoutes } from "../../connections/routes/connection-routes"
import { sandboxDriverCredentials, sandboxDriverRoutes } from "../../sandbox/routes/sandbox-driver-routes"
import { workspaceShareRoutes } from "./share-routes"
import { authenticatedGitHubCloneSource } from "../repository-clone"

const createBody = z
  .object({
    projectId: z.string().optional(),
    projectName: z.string().optional(),
    workspaceName: z.string().optional(),
    repoUrl: z.string().optional(),
    connectionId: z.string().optional(),
    repo: z.object({ fullName: z.string().min(3) }).strict().optional(),
    // `repoName` lets the caller override the auto-derived basename from the
    // repo URL. `remoteDirectory` carries the path the runtime should mount
    // inside the remote VM.
    repoName: z.string().optional(),
    gitBranch: z.string().optional(),
    remoteDirectory: z.string().optional(),
    driver: z.string().optional(),
    provision: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Boolean(body.connectionId) === Boolean(body.repo), {
    message: "connectionId and repo must be provided together",
  })

const log = Log.create({ service: "workspace-routes" })

function slug(input: string | undefined, alt: string) {
  const txt = (input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return txt || alt
}

function workspaceJson(ws: Awaited<ReturnType<typeof resolveWorkspace>>) {
  if (!ws) return
  const live = getSupervisorSandboxStatus(ws.id)
  const stopped = live === "stopped" ? "stopped" : undefined
  const backing = workspaceBacking(ws)
  const access = backing.kind === "cloud-vm" ? "cloud" : backing.kind === "user-hosted" ? "user-hosted" : "local"
  return {
    workspaceId: ws.id,
    projectId: ws.project_id ?? ws.id,
    directory: backing.kind === "local-worktree" ? ws.directory : (ws.remote_directory ?? ws.directory),
    workspaceName: ws.workspace_name ?? null,
    access,
    backing,
    kind: ws.kind,
    driver: ws.driver ?? null,
    status: stopped ?? ws.status ?? null,
    git: {
      repo: ws.repo_name ?? null,
      branch: ws.git_branch ?? null,
      remote: ws.git_remote ?? null,
    },
  }
}

function startCloudWorkspaceProvisioning(input: {
  services?: ControlPlaneServices
  options: WorkspaceRouteOptions
  ws: Workspace
  driver: string
  provisionRepoUrl?: string
  provisionSecrets?: Array<{ name: string; value: string; hosts: string[]; header?: string }>
  gitBranch?: string
  remoteDirectory: string
}) {
  const sandboxManager = input.services?.sandbox.sandboxManager
  const work = sandboxManager?.ensure(input.ws.id, {
    homeRegion: input.options.defaultHomeRegion ?? input.services?.defaultHomeRegion ?? "us-east",
    labels: {
      projectId: input.ws.project_id ?? "",
    },
    workspaceRoot: input.remoteDirectory,
    source: input.provisionRepoUrl
      ? {
          kind: "git",
          repoUrl: input.provisionRepoUrl,
          ...(input.gitBranch ? { branch: input.gitBranch } : {}),
        }
      : { kind: "empty" },
    ...(input.provisionSecrets?.length ? { secrets: input.provisionSecrets } : {}),
  }) ?? Promise.reject(new Error(`sandbox manager unavailable: ${input.ws.id}`))

  void work.catch(async (err) => {
    log.warn("Create cloud workspace provisioning failed", {
      workspaceId: input.ws.id,
      driver: input.driver,
      error: err instanceof Error ? err.message : String(err),
    })
    await discardSupervisorSandbox(input.ws.id, "provision_failed").catch(() => {})
    await deleteWorkspace(input.ws.id).catch(() => {})
  })
}

export function WorkspaceRoutes(services?: ControlPlaneServices, options: WorkspaceRouteOptions = {}) {
  const controlPlaneRateLimiter =
    options.controlPlaneRateLimiter ??
    createFixedWindowConnectionRateLimiter({
      limit: 120,
      windowMs: 60_000,
    })
  return (
    new Hono()
      .route("/", sandboxDriverRoutes(services, options))
      .get("/resolve", async (c) => {
        const authResult = await signedOrError(c.req.raw, options, services)
        if ("error" in authResult) return c.json(authResult.error, authResult.status)
        const directory = c.req.query("directory")
        if (isGlobalDirectory(directory)) return c.json(workspaceJson(globalWorkspace(directory!)))
        const explicitWorkspaceId = c.req.query("workspaceId") || c.req.query("workspace")
        const directoryWorkspaceId = explicitWorkspaceId ? undefined : workspaceIdFromDirectoryRef(directory)
        const ws = await resolveWorkspace({
          workspaceId: explicitWorkspaceId ?? directoryWorkspaceId,
          directory: directoryWorkspaceId ? undefined : directory,
          create: c.req.query("create") === "true",
        })
        if (authResult.auth && explicitWorkspaceId && !ws) {
          try {
            const opened = await openSignedWorkspaceJson({
              services,
              rateLimiter: controlPlaneRateLimiter,
              auth: authResult.auth,
              workspaceId: explicitWorkspaceId,
            })
            return c.json(opened.body, opened.status)
          } catch (err) {
            if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
            throw err
          }
        }
        if (authResult.auth && !explicitWorkspaceId && !ws) {
          try {
            const opened = await openSignedWorkspaceByDirectory({
              services,
              rateLimiter: controlPlaneRateLimiter,
              auth: authResult.auth,
              directory,
            })
            if (opened) return c.json(opened.body, opened.status)
          } catch (err) {
            if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
            throw err
          }
        }
        if (authResult.auth && !explicitWorkspaceId && ws?.kind === "local") {
          try {
            const opened = await openSignedWorkspaceJson({
              services,
              rateLimiter: controlPlaneRateLimiter,
              auth: authResult.auth,
              workspaceId: ws.id,
            })
            return c.json(opened.body, opened.status)
          } catch (err) {
            if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
            throw err
          }
        }
        if (!ws) return c.json({ error: apiError("workspace_not_found", "Workspace not found") }, 404)
        if (authResult.auth && ws.kind === "cloud") {
          try {
            const authority = requireAuthority(services)
            await authority.usersMe(authResult.auth)
            const rateLimit = await controlPlaneRateLimitError(services, controlPlaneRateLimiter, authResult.auth, {
              key: `workspaces.open:${ws.id}`,
              action: "workspaces.open.denied",
              workspaceId: ws.id,
            })
            if (rateLimit) return c.json(rateLimit.body, rateLimit.status)
            await authority.authorizeWorkspaceOpen(authResult.auth, {
              workspaceId: ws.id,
            })
          } catch (err) {
            if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
            throw err
          }
        }
        return c.json(workspaceJson(ws))
      })
      .get("/", async (c) => {
        const access = c.req.query("access")
        const authResult = await signedOrError(
          c.req.raw,
          {
            ...options,
            requireSigned: access === "cloud" || access === "user-hosted",
          },
          services,
        )
        if ("error" in authResult) return c.json(authResult.error, authResult.status)
        if (authResult.auth && (access === "cloud" || access === "user-hosted")) {
          try {
            const authority = requireAuthority(services)
            await authority.usersMe(authResult.auth)
            const rateLimit = await controlPlaneRateLimitError(services, controlPlaneRateLimiter, authResult.auth, {
              key: `workspaces.list:${access}`,
              action: "workspaces.list.denied",
            })
            if (rateLimit) return c.json(rateLimit.body, rateLimit.status)
            const workspaces = await authority.listWorkspaces(authResult.auth)
            return c.json({
              workspaces:
                Array.isArray(workspaces) && access === "user-hosted"
                  ? workspaces.filter((item) => rec(item)?.access === "user-hosted")
                  : workspaces,
            })
          } catch (err) {
            if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
            throw err
          }
        }
        return c.json(await listProjects())
      })
      .route("/", workspaceConnectionRoutes(services, options))
      .post("/:id/user-hosted/register", async (c) => {
        return registerLocalHostLink(c, services, options)
      })
      .post("/:id/user-hosted/heartbeat", async (c) => {
        return heartbeatLocalHostLink(c, services, options, controlPlaneRateLimiter)
      })
      .post("/:id/user-hosted/pause", async (c) => {
        return pauseLocalHostLink(c, services, options)
      })
      .route("/", workspaceShareRoutes(services, options))
      .delete("/:id", async (c) => {
        const id = c.req.param("id")
        const ws = await resolveWorkspace({ workspaceId: id })
        if (!ws) return c.json({ error: apiError("workspace_not_found", "Workspace not found") }, 404)
        if (
          ws.kind === "cloud" &&
          (c.req.query("access") === "cloud" || bearerToken(c.req.raw.headers.get("authorization")))
        ) {
          const authResult = await signedOrError(
            c.req.raw,
            {
              ...options,
              requireSigned: true,
            },
            services,
          )
          if ("error" in authResult) return c.json(authResult.error, authResult.status)
          const auth = authResult.auth
          if (!auth)
            return c.json(
              controlPlaneAuthErrorBody(
                new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required"),
              ),
              401,
            )
          try {
            await requireAuthority(services).usersMe(auth)
            await requireAuthority(services).deleteWorkspace(auth, { workspaceId: id })
            captureWorkspaceTelemetry({
              services,
              auth,
              event: "workspace.delete",
              workspaceId: id,
              properties: {
                access: "cloud",
                backing: "cloud-vm",
              },
            })
          } catch (err) {
            if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
            throw err
          }
        }
        if (ws.kind === "cloud") {
          const sandboxManager = services?.sandbox.sandboxManager
          if (sandboxManager) {
            await sandboxManager.destroy(id).catch((err) => {
              log.warn("Sandbox destroy during workspace delete failed", {
                workspaceId: id,
                error: err instanceof Error ? err.message : String(err),
              })
            })
            await sandboxManager.release(id).catch((err) => {
              log.warn("Sandbox lease release during workspace delete failed", {
                workspaceId: id,
                error: err instanceof Error ? err.message : String(err),
              })
            })
          }
        }
        await discardSupervisorSandbox(id, "workspace_deleted").catch(() => {})
        await deleteWorkspace(id)
        return c.json({ ok: true })
      })
      // NOTE: there is deliberately no `POST /ensure` route. It was an
      // unauthenticated endpoint that booted billable cloud runtimes; runtime
      // ensure now only happens behind the authenticated connection flow.
      .post("/create", async (c) => {
        const authResult = await signedOrError(c.req.raw, options, services)
        if ("error" in authResult) return c.json(authResult.error, authResult.status)
        const parsed = parsedBody(createBody, await c.req.json().catch(() => ({})))
        if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status)
        const body = parsed.body
        const cfg = await loadUserConfig()
        const driverConfig = sandboxDriverConfig(cfg)
        const requestedDriver = body.driver?.trim()
        if (requestedDriver && !isSandboxDriverID(requestedDriver)) {
          return c.json(
            { error: apiError("sandbox_driver_unsupported", "Unsupported sandbox driver", { driver: requestedDriver }) },
            400,
          )
        }
        const requestedId = requestedDriver ? sandboxDriverId(requestedDriver, driverConfig) : undefined
        if (requestedDriver && !requestedId) {
          return c.json(
            {
              error: apiError("sandbox_driver_unavailable", "Sandbox driver is not available", {
                driver: requestedDriver,
              }),
            },
            400,
          )
        }
        const id =
          requestedId ??
          services?.sandbox.defaultDriver ??
          defaultSandboxDriverID(driverConfig)
        const credential = await sandboxDriverCredentials(options, services)
          // Kind-scoped: unscoped, a model-provider API key under the same id
          // (`vercel` is both) satisfied this gate with no sandbox credential
          // present, so creation passed here and failed later at launch.
          .getCredentialByProvider(id, "sandbox_driver")
          .catch(() => undefined)
        const hasCredentials = credential?.status === "available" || !!sandboxDriverAuth(driverConfig, id)
        log.info("Create cloud workspace requested", {
          driver: id,
          requestedDriver: body.driver,
          projectId: body.projectId,
          workspaceName: body.workspaceName,
          hasRepoUrl: !!body.repoUrl?.trim() || !!body.repo,
          hasAuth: hasCredentials,
        })
        if (!hasCredentials) {
          log.warn("Create cloud workspace rejected: missing credentials", {
            driver: id,
            projectId: body.projectId,
            workspaceName: body.workspaceName,
          })
          return c.json(
            { error: apiError("sandbox_driver_credentials_missing", `Missing ${id} credentials`, { driver: id }) },
            400,
          )
        }

        // Same generator as the hosted Worker route (`newWorkspaceId` is
        // Web-Crypto-only, so one module serves both runtimes). Timestamp
        // prefix + 80 bits of randomness: the old bare-timestamp id was
        // guessable inside any plausible creation window.
        const workspaceId = newWorkspaceId()
        const projectId = body.projectId?.trim() || workspaceId
        const rawWorkspaceName = body.workspaceName?.trim()
        const name = slug(rawWorkspaceName, "main")

        let repoUrl = body.repoUrl?.trim()
        let provisionRepoUrl = repoUrl
        let provisionSecrets: Array<{ name: string; value: string; hosts: string[]; header?: string }> | undefined

        if (body.connectionId && body.repo) {
          const repositoryFullName = body.repo.fullName
          if (!options.connections) {
            return c.json({ error: apiError("repository_connections_unavailable", "Repository connections are unavailable") }, 501)
          }
          const access = await options.connections.repositoryForAuth(authResult.auth, body.connectionId, repositoryFullName)
          if (!access.ok) return c.json({ error: apiError(access.code, "Repository connection is not available") }, access.status)
          repoUrl = access.repository.cloneUrl
          const source = authenticatedGitHubCloneSource(access.repository.cloneUrl, access.token)
          provisionRepoUrl = source.repoUrl
          provisionSecrets = [source.secret]
        }

        if (!repoUrl && body.projectId) {
          const root = await getProjectWorkspace(body.projectId)
          if (!root)
            return c.json({ error: apiError("project_workspace_not_found", "Project workspace not found") }, 404)
          repoUrl = root.git_remote || root.repo_url
          if (!repoUrl && id !== "docker") {
            return c.json(
              {
                error: apiError("project_remote_required", "Project has no remote URL to clone in sandbox"),
              },
              400,
            )
          }
        }

        if (!repoUrl && id !== "docker") {
          return c.json({ error: apiError("cloud_workspace_source_required", "repoUrl or projectId is required") }, 400)
        }

        if (!services?.sandbox.sandboxManager) {
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

        // Auto-add git host to network allowlist so sandbox can clone
        if (repoUrl) {
          ensureHostForRepo(repoUrl)
        }

        const repoName = body.repoName?.trim() || (repoUrl ? repoNameFromUrl(repoUrl) : undefined)
        const gitBranch = body.gitBranch?.trim() || (rawWorkspaceName ? name : undefined)
        const remote_directory = body.remoteDirectory?.trim() || WORKSPACE_DIR
        const directory = remote_directory
        const status = "acquiring_sandbox" as const

        let orgId: string | undefined
        if (authResult.auth) {
          try {
            const authority = requireAuthority(services)
            await authority.usersMe(authResult.auth)
            orgId = await authority.resolveOrgId(authResult.auth)
          } catch (err) {
            if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
            throw err
          }
        }

        const ws = await ensureWorkspace({
          workspaceId,
          org_id: orgId,
          project_id: projectId,
          project_name: body.projectName?.trim() || repoName || name,
          workspace_name: name,
          directory,
          kind: "cloud",
          driver: id,
          repo_url: repoUrl,
          git_branch: gitBranch,
          remote_directory,
          status,
        })
        if (!ws) return c.json({ error: apiError("cloud_workspace_create_failed", "failed to create workspace") }, 500)
        if (authResult.auth) {
          try {
            await requireAuthority(services).createCloudWorkspace(authResult.auth, {
              workspaceId: ws.id,
              projectId,
              displayName: ws.workspace_name ?? ws.project_name ?? repoName ?? ws.id,
              repoUrl,
              repoName,
              gitBranch,
              ...(options.defaultHomeRegion ? { homeRegion: options.defaultHomeRegion } : {}),
            })
            captureWorkspaceTelemetry({
              services,
              auth: authResult.auth,
              event: "workspace.cloud.create",
              workspaceId: ws.id,
              properties: {
                projectId,
                driver: id,
                repoName,
                gitBranch,
              },
            })
          } catch (err) {
            await deleteWorkspace(ws.id).catch(() => {})
            if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
            throw err
          }
        }
        log.info("Create cloud workspace stored", {
          workspaceId: ws.id,
          projectId,
          directory: ws.directory,
          driver: id,
          repoUrl,
          remoteDirectory: remote_directory,
        })

        startCloudWorkspaceProvisioning({
          services,
          options,
          ws,
          driver: id,
          provisionRepoUrl,
          provisionSecrets,
          gitBranch,
          remoteDirectory: remote_directory,
        })

        return c.json(workspaceJson(ws))
      })
  )
}
