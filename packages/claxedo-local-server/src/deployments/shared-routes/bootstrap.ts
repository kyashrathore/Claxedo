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
import { controlPlaneAuthConfig } from "@claxedo/server-core/platform/auth/auth"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import { isLoopbackLocalRequest } from "@claxedo/server-core/platform/http/peer-address"

type Options = {
  authConfig?: ControlPlaneAuthConfig
  verifier?: ControlPlaneTokenVerifier
  services?: ControlPlaneServicesContract
  env?: Record<string, string | undefined>
}

function rec(input: unknown) {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}

function txt(input: unknown) {
  return typeof input === "string" ? input : undefined
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

async function localBootstrapBody(options: Options) {
  return {
    healthy: true,
    version: version(options),
    path: bootPath(),
    project: await listProjects(),
    provider_auth: providerAuthMethods(),
  }
}

async function localShellBootstrapBody(options: Options) {
  return {
    healthy: true,
    version: version(options),
    path: bootPath(),
    project: await listProjects(),
  }
}

function localBootstrap(url: string, options: Options) {
  if (new URL(url).searchParams.get("scope") === "shell") return localShellBootstrapBody(options)
  return localBootstrapBody(options)
}

/**
 * The project inventory a SIGNED bootstrap answers with — the self-hosted twin
 * of the hosted control plane's `signedShellProjects` (claxedo-server
 * routes/hosted/shell.ts). Exported for the same reason that one is: this
 * grouping decides which directories the app shell treats as relay-backed, and
 * that decision is worth pinning directly rather than through a whole route.
 */
export function signedBootstrapProjects(workspaces: unknown[]) {
  const groups = new Map<string, {
    id: string
    name: string
    directories: string[]
    workspaces: Record<string, unknown>
  }>()
  for (const workspace of workspaces) {
    const row = rec(workspace)
    const workspaceId = txt(row?.workspace_id) ?? txt(row?.workspaceId)
    if (!workspaceId) continue
    // A workspace served elsewhere is ADDRESSED by its id; the host's own path
    // is location metadata. Every row here comes from the signed control plane,
    // so every one of them is relay-backed — a local workspace never reaches
    // this body. Stating the host's path as `directory` made the client resolve
    // a `/w/<id>` route to a path on ANOTHER machine
    // (`workspaceRouteIdentity`), so its panes registered that path as their
    // scope while both event lanes publish under `workspace:<id>` and every
    // live frame of an attached turn was dropped for the mismatch. Same shape
    // the hosted control plane already serves (`signedShellProjects`).
    const directory = `workspace:${workspaceId}`
    const remoteDirectory = txt(row?.remote_directory) ?? txt(row?.remoteDirectory)
    const projectId = txt(row?.project_id) ?? txt(row?.projectID) ?? workspaceId
    const workspaceName = txt(row?.workspace_name) ?? txt(row?.workspaceName) ?? txt(row?.display_name) ?? txt(row?.displayName) ?? workspaceId
    const group = groups.get(projectId) ?? {
      id: projectId,
      name: txt(row?.project_name) ?? txt(row?.projectName) ?? txt(row?.display_name) ?? txt(row?.displayName) ?? projectId,
      directories: [],
      workspaces: {},
    }
    group.directories.push(workspaceId)
    group.workspaces[workspaceId] = {
      id: workspaceId,
      kind: txt(row?.access) ?? txt(row?.backing) ?? "cloud",
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
    project: await Promise.all(projects.map(async (project) => ({ ...project, ...await getProjectMetadata(project.id) }))),
    provider_auth: providerAuthMethods(),
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

export function BootstrapRoutes(options: Options = {}) {
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
