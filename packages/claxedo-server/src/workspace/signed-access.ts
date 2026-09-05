import { WORKSPACE_DIR } from "@claxedo/sandbox-manager/defaults"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { ConnectionRateLimiter } from "../platform/auth/rate-limit"
import type { ControlPlaneServices } from "../authority/services"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import { rec, txt } from "./route-support"
import { controlPlaneRateLimitError } from "./runtime-token-guards"

export function signedWorkspaceJson(result: unknown, workspaceId: string) {
  const workspace = rec(rec(result)?.workspace)
  const resolvedWorkspaceId = txt(workspace?.workspace_id) ?? txt(workspace?.workspaceId) ?? workspaceId
  const access = txt(workspace?.access)
  const backing = txt(workspace?.backing)
  const branch = txt(workspace?.git_branch) ?? txt(workspace?.gitBranch)
  const repoUrl = txt(workspace?.repo_url) ?? txt(workspace?.repoUrl)
  const repoName = txt(workspace?.repo_name) ?? txt(workspace?.repoName)
  const normalizedAccess = access === "user-hosted"
    ? "user-hosted"
    : access === "cloud" || backing === "cloud-vm"
      ? "cloud"
      : "local"
  return {
    workspaceId: resolvedWorkspaceId,
    orgId: txt(workspace?.org_id) ?? txt(workspace?.orgId),
    projectId: txt(workspace?.project_id) ?? txt(workspace?.projectId) ?? resolvedWorkspaceId,
    directory: txt(workspace?.remote_directory) ?? txt(workspace?.remoteDirectory) ?? WORKSPACE_DIR,
    workspaceName: txt(workspace?.display_name)
      ?? txt(workspace?.workspace_name)
      ?? txt(workspace?.workspaceName),
    access: normalizedAccess,
    backing: normalizedAccess === "cloud"
      ? {
          kind: "cloud-vm" as const,
          repoUrl,
          repoName,
          branch,
        }
      : normalizedAccess === "user-hosted"
        ? {
            kind: "user-hosted" as const,
            workspaceName: txt(workspace?.display_name)
              ?? txt(workspace?.workspace_name)
              ?? txt(workspace?.workspaceName),
            projectName: txt(workspace?.project_name) ?? txt(workspace?.projectName),
            branch,
          }
        : {
            kind: "local-worktree" as const,
            branch,
          },
    kind: access === "user-hosted"
      ? "user-hosted"
      : access === "cloud" || backing === "cloud-vm"
        ? "cloud"
        : "local",
    driver: null,
    status: "ready",
    git: {
      repo: repoName ?? null,
      branch: branch ?? null,
      remote: repoUrl ?? null,
    },
  }
}

export async function openSignedWorkspaceByDirectory(input: {
  services: ControlPlaneServices | undefined
  rateLimiter: ConnectionRateLimiter
  auth: SignedControlPlaneAuth
  directory: string | undefined
}) {
  if (!input.directory) return
  const authority = requireAuthority(input.services)
  await authority.usersMe(input.auth)
  const workspaces = await authority.listWorkspaces(input.auth)
  const workspaceIds = Array.isArray(workspaces)
    ? [...new Set(workspaces
        .filter((workspace) => signedWorkspaceMatchesDirectory(workspace, input.directory))
        .map(signedWorkspaceId)
        .filter((workspaceId): workspaceId is string => !!workspaceId))]
    : []
  if (workspaceIds.length > 1) {
    return {
      body: {
        error: {
          code: "workspace_directory_ambiguous",
          message: "Multiple workspaces use this runtime directory; resolve with a canonical workspaceId",
        },
      },
      status: 409,
    } as const
  }
  const workspaceId = workspaceIds[0]
  if (!workspaceId) return
  return await openSignedWorkspaceJson({
    services: input.services,
    rateLimiter: input.rateLimiter,
    auth: input.auth,
    workspaceId,
  })
}

export async function openSignedWorkspaceJson(input: {
  services: ControlPlaneServices | undefined
  rateLimiter: ConnectionRateLimiter
  auth: SignedControlPlaneAuth
  workspaceId: string
}) {
  const authority = requireAuthority(input.services)
  await authority.usersMe(input.auth)
  const rateLimit = await controlPlaneRateLimitError(input.services, input.rateLimiter, input.auth, {
    key: `workspaces.open:${input.workspaceId}`,
    action: "workspaces.open.denied",
    workspaceId: input.workspaceId,
  })
  if (rateLimit) return rateLimit
  return {
    body: signedWorkspaceJson(
      await authority.openWorkspace(input.auth, { workspaceId: input.workspaceId }),
      input.workspaceId,
    ),
    status: 200,
  } as const
}

function signedWorkspaceId(workspace: unknown) {
  const row = rec(workspace)
  return txt(row?.workspace_id) ?? txt(row?.workspaceId)
}

function signedWorkspaceDirectory(workspace: unknown) {
  const row = rec(workspace)
  return txt(row?.remote_directory) ?? txt(row?.remoteDirectory) ?? txt(row?.directory)
}

function signedWorkspaceMatchesDirectory(workspace: unknown, directory: string | undefined) {
  if (!directory) return false
  const id = signedWorkspaceId(workspace)
  return signedWorkspaceDirectory(workspace) === directory ||
    id === directory ||
    (id ? `workspace:${id}` === directory : false)
}
