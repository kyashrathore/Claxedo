import { workspaceAgentExtensionRecords } from "../../hosts/agent-extensions/workspace"
import { WORKSPACE_DIR } from "@claxedo/sandbox-manager/defaults"
import type { SignedControlPlaneAuth } from "../../authority/auth"
import type { ConnectionRateLimiter } from "../../authority/rate-limit"
import type { ControlPlaneServices } from "../../authority/services"
import { requireAuthority } from "../../authority/authority"
import { controlPlaneRateLimitError, rec, txt } from "./user-hosted"

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
  const workspaceId = Array.isArray(workspaces)
    ? signedWorkspaceId(workspaces.find((workspace) => signedWorkspaceMatchesDirectory(workspace, input.directory)))
    : undefined
  if (!workspaceId) return
  return await openSignedWorkspaceJson({
    services: input.services,
    rateLimiter: input.rateLimiter,
    auth: input.auth,
    workspaceId,
  })
}

export async function syncWorkspaceAgentExtensionsForSignedUser(
  services: ControlPlaneServices | undefined,
  auth: SignedControlPlaneAuth,
  workspaceId: string,
) {
  const authority = services?.authority
  if (!authority) return
  const [installs, policyOverrides] = await Promise.all([
    authority.listWorkspaceAgentExtensions(auth, { workspaceId }),
    typeof authority.listAgentExtensionPolicyOverrides === "function"
      ? authority.listAgentExtensionPolicyOverrides(auth, { workspaceId })
      : [],
  ])
  const overrides = policyOverrides as import("../../hosts/agent-extensions/runtime-config").AgentExtensionPolicyOverride[]
  const records = workspaceAgentExtensionRecords(installs)
  const supervisorMod = "../../workspace/supervisor"
  const embeddedMod = "../../deployments/local/embedded-workspace-runtime"
  const [{ syncWorkspaceRuntimeAgentExtensions }, { syncEmbeddedWorkspaceRuntimeAgentExtensions }] = await Promise.all([
    import(/* @vite-ignore */ supervisorMod),
    import(/* @vite-ignore */ embeddedMod),
  ])
  await Promise.all([
    syncWorkspaceRuntimeAgentExtensions(workspaceId, records, { policyOverrides: overrides }),
    syncEmbeddedWorkspaceRuntimeAgentExtensions(workspaceId, records, { policyOverrides: overrides }),
  ])
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
