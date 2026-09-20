import { Hono } from "hono"
import os from "os"
import { providerAuthMethods } from "../../credentials/provider-auth/service"
import { getProjectMetadata, listProjects } from "@claxedo/server-core/workspace/store/index"
import { dataDir, stateDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import type { ControlPlaneServicesContract } from "@claxedo/server-core/authority/control-plane-contract"
import {
  ControlPlaneAuthError,
  bearerToken,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  type ControlPlaneTokenVerifier,
  type ControlPlaneAuthConfig,
  type SignedControlPlaneAuth,
} from "@claxedo/server-core/platform/auth/auth"
import { controlPlaneAuthConfig, issuesSessions } from "@claxedo/server-core/platform/auth/auth"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import { isLoopbackLocalRequest } from "@claxedo/server-core/platform/http/peer-address"
import { asRecord, asString } from "@claxedo/helpers/guards"

type Options = {
  authConfig?: ControlPlaneAuthConfig
  verifier?: ControlPlaneTokenVerifier
  services?: ControlPlaneServicesContract
  env?: Record<string, string | undefined>
  /**
   * Whether this composition serves the host aggregate `/api/wr/events` — the
   * stream naming no workspace that carries every runtime this process hosts.
   * The client cannot derive it: a self-hosted node runs its issuer on
   * localhost too, so the server URL does not say it, and the build-time auth
   * flag belongs to the bundle rather than to the server it happens to reach.
   * The composition passes one value to both this route and the runtime
   * proxy's mount, so the declaration cannot disagree with what is served.
   */
  hostAggregateEvents: boolean
  /**
   * This machine's enrollment id at the control plane, when it has one.
   *
   * A client reads it to answer "is the machine that serves this workspace
   * me": a control-plane row names its host by enrollment id, and nothing else
   * on the wire ties that row to the server the client is already talking to.
   * Absent means unenrolled, which still serves this machine's own directories.
   */
  hostEnrollmentId?: () => string | undefined
}



function bootPath(directory?: string) {
  const dir = directory?.trim() ?? ""
  return {
    home: os.homedir(),
    state: stateDir(),
    config: dataDir(),
    worktree: dir,
    directory: dir,
  }
}

function version(options: Options) {
  return options.env?.npm_package_version || "1.0.0"
}

function events(options: Options) {
  return { hostAggregate: options.hostAggregateEvents }
}

/**
 * Read from the composition's own auth config rather than declared beside it,
 * so the body cannot say "sign in" about a server that authenticates by
 * loopback.
 */
function declaresSessions(options: Options) {
  return issuesSessions(options.authConfig ?? controlPlaneAuthConfig())
}

function deployment(options: Options) {
  return { issuesSessions: declaresSessions(options) }
}

function bootstrapHostIdentity(options: Options) {
  return { enrollment: options.hostEnrollmentId?.() ?? null }
}

async function localBootstrapBody(options: Options) {
  return {
    healthy: true,
    version: version(options),
    path: bootPath(),
    events: events(options),
    deployment: deployment(options),
    host: bootstrapHostIdentity(options),
    project: await listProjects(),
    provider_auth: providerAuthMethods(),
  }
}

async function localShellBootstrapBody(options: Options) {
  return {
    healthy: true,
    version: version(options),
    path: bootPath(),
    events: events(options),
    deployment: deployment(options),
    host: bootstrapHostIdentity(options),
    project: await listProjects(),
  }
}

function localBootstrap(url: string, options: Options) {
  if (new URL(url).searchParams.get("scope") === "shell") return localShellBootstrapBody(options)
  return localBootstrapBody(options)
}

/**
 * The `project` array a SIGNED bootstrap body carries: the authority's
 * workspace rows grouped by project.
 *
 * The hosted control plane answers the same shape from its own copy,
 * `signedShellProjects`. This module cannot be shared into the Worker bundle
 * — it reaches the fs-backed workspace store and agent config — so the two
 * are changed together or one client meets two shapes.
 */
function signedBootstrapProjects(workspaces: unknown[]) {
  const groups = new Map<string, {
    id: string
    name: string
    directories: string[]
    workspaces: Record<string, unknown>
  }>()
  for (const workspace of workspaces) {
    const row = asRecord(workspace)
    const workspaceId = asString(row?.workspace_id) ?? asString(row?.workspaceId)
    if (!workspaceId) continue
    // A control-plane row is ADDRESSED by its id; the serving host's path is
    // placement metadata. The client resolves a `/w/<id>` route through
    // `workspaceRouteIdentity` and registers its panes under what this says,
    // while both event lanes publish under `workspace:<id>`: a filesystem path
    // here would put every live frame of an attached turn on a scope nothing
    // publishes to. Same shape the hosted control plane serves
    // (`signedShellProjects`).
    const directory = `workspace:${workspaceId}`
    const remoteDirectory = asString(row?.remote_directory) ?? asString(row?.remoteDirectory)
    const projectId = asString(row?.project_id) ?? asString(row?.projectID) ?? workspaceId
    const workspaceName = asString(row?.workspace_name) ?? asString(row?.workspaceName) ?? asString(row?.display_name) ?? asString(row?.displayName) ?? workspaceId
    const group = groups.get(projectId) ?? {
      id: projectId,
      name: asString(row?.project_name) ?? asString(row?.projectName) ?? asString(row?.display_name) ?? asString(row?.displayName) ?? projectId,
      directories: [],
      workspaces: {},
    }
    group.directories.push(workspaceId)
    group.workspaces[workspaceId] = {
      id: workspaceId,
      // The row's own placement, passed through rather than restated: the app
      // narrows this word once, in `placement-wire.ts`. A row naming no backing
      // is the provisioner's, never the reader's own machine — defaulting the
      // other way would put somebody else's workspace on this one.
      backing: asString(row?.backing) === "local-worktree" ? "local-worktree" : "cloud-vm",
      workspace_name: workspaceName,
      directory,
      ...(remoteDirectory ? { remote_directory: remoteDirectory } : {}),
    }
    groups.set(projectId, group)
  }
  return [...groups.values()].map((group) => ({
    id: group.id,
    name: group.name,
    worktree: group.directories[0] ?? group.id,
    sandboxes: group.directories,
    workspaces: group.workspaces,
  }))
}

async function signedBootstrapBody(auth: SignedControlPlaneAuth, options: Options) {
  const workspaces = await requireAuthority(options.services).listWorkspaces(auth)
  const projects = signedBootstrapProjects(Array.isArray(workspaces) ? workspaces : [])
  return {
    healthy: true,
    version: version(options),
    path: { home: "", state: "", config: "", worktree: "", directory: "" },
    events: events(options),
    deployment: deployment(options),
    host: bootstrapHostIdentity(options),
    project: await Promise.all(projects.map(async (project) => ({ ...project, ...await getProjectMetadata(project.id) }))),
    provider_auth: providerAuthMethods(),
  }
}

/**
 * What a caller holding no credential learns from a server that issues
 * sessions: the posture it has to satisfy, and nothing of the machine behind
 * it. The client reads this before its first render to decide whether a signed
 * session is required at all, so refusing the request would leave it guessing
 * from the URL — and answering `localBootstrap` would hand an anonymous caller
 * this node's project list and home directory.
 */
function unauthenticatedDeclarationBody(options: Options) {
  return {
    healthy: true,
    version: version(options),
    events: events(options),
    deployment: deployment(options),
  }
}

function localOnlyBody(label: string) {
  return {
    error: {
      code: "local_only_projection_route",
      message: `${label} is local-only and is not available through signed/team Control Plane access`,
    },
  }
}

async function signedBootstrapAuth(request: Request, options: Options) {
  const config = options.authConfig ?? controlPlaneAuthConfig()
  if (!config.enabled && config.mode === "local-only") {
    throw new ControlPlaneAuthError(403, "invalid_bearer_token", "Local bootstrap compatibility is local-only and is not available through signed/team Control Plane access")
  }
  const context = await controlPlaneAuthContext(request, {
    config,
    verifier: options.verifier,
  })
  if (context.mode === "signed") return context
  throw new ControlPlaneAuthError(503, "signed_cloud_auth_disabled", context.reason)
}

export function BootstrapRoutes(options: Options) {
  return new Hono()
    .get("/api/claxedo/bootstrap", async (c) => {
      try {
        const token = bearerToken(c.req.header("authorization") ?? null)
        const authConfig = options.authConfig ?? controlPlaneAuthConfig()
        if (token && isLoopbackLocalRequest(c.req.raw)) {
          return c.json(await localBootstrap(c.req.url, options))
        }
        if (token) {
          try {
            const auth = await signedBootstrapAuth(c.req.raw, { ...options, authConfig })
            return c.json(await signedBootstrapBody(auth, options))
          } catch (err) {
            if (
              err instanceof ControlPlaneAuthError &&
              err.status === 403 &&
              err.code === "invalid_bearer_token"
            ) {
              return c.json(localOnlyBody("Local bootstrap compatibility"), 403)
            }
            if (err instanceof ControlPlaneAuthError) {
              return c.json(controlPlaneAuthErrorBody(err), err.status)
            }
            throw err
          }
        }
        if (declaresSessions(options)) return c.json(unauthenticatedDeclarationBody(options))
        return c.json(await localBootstrap(c.req.url, options))
      } catch (err) {
        return c.json({
          error: {
            code: "bootstrap_provider_unavailable",
            message: err instanceof Error ? err.message : String(err),
          },
        }, 502)
      }
    })
}
