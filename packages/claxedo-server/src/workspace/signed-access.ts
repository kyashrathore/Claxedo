import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { workspaceSupervisor, workspaceSupervisorInstalled } from "@claxedo/server-core/workspace/supervisor-port"
import { localWorkspaceRuntime, localWorkspaceRuntimeInstalled } from "@claxedo/server-core/workspace/local-runtime-port"
import { workspaceAgentExtensionRecords } from "@claxedo/server-core/hosts/agent-extensions/workspace"
import { WORKSPACE_DIR } from "@claxedo/sandbox-manager/defaults"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { ConnectionRateLimiter } from "../platform/auth/rate-limit"
import type { ControlPlaneServices } from "../authority/services"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import { rec, txt } from "./route-support"
import { controlPlaneRateLimitError } from "./runtime-token-guards"

const log = Log.create({ service: "signed-workspace-access" })

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
  const overrides = policyOverrides as import("@claxedo/server-core/hosts/agent-extensions/runtime-config").AgentExtensionPolicyOverride[]
  const records = workspaceAgentExtensionRecords(installs)
  // Both reached through composed ports. They used to be dynamic imports
  // written as VARIABLES with `@vite-ignore` so a Worker build would not carry
  // the Node-only supervisor or the embedded runtime — right intent, wrong
  // mechanism: such an edge is invisible to tsc, to import rewriters, and to
  // every import-graph gate, and a move of this file had to update them by
  // hand. Ports keep the Worker clean and stay visible.
  // Both must actually run. This function only executes on a composition that
  // has a supervisor AND an embedded runtime, so a missing one is a broken
  // composition, not a mode. The dynamic imports this replaced failed loudly in
  // that case; a silently-skipped sync would leave a workspace's Agent
  // Extensions stale with nothing said, which is the failure class the ports
  // exist to prevent rather than to introduce.
  // The supervisor is required: it is what syncs a CLOUD workspace's runtime,
  // and this path only runs for a composition that provisions them. A silently
  // skipped sync there would leave a workspace's Agent Extensions stale with
  // nothing said — the failure class these ports exist to prevent, not cause.
  if (!workspaceSupervisorInstalled()) {
    throw new Error("signed workspace Agent Extension sync requires a configured workspace supervisor")
  }
  // The embedded local runtime is genuinely optional — a hosted composition has
  // none. Skipping is correct there, but it is logged rather than silent so an
  // absent local sync on a desktop is visible.
  if (!localWorkspaceRuntimeInstalled()) {
    log.info("no local workspace runtime configured; syncing agent extensions to the supervisor only", { workspaceId })
  }
  await Promise.all([
    workspaceSupervisor().syncAgentExtensions(workspaceId, records, { policyOverrides: overrides }),
    localWorkspaceRuntimeInstalled()
      ? localWorkspaceRuntime().syncAgentExtensions(workspaceId, records, { policyOverrides: overrides })
      : Promise.resolve(),
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
