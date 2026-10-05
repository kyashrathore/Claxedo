import {
  hostedSandboxNetworkPolicy,
  type SandboxBrokeredSecret,
  type SandboxManagerInput,
  type SandboxSource,
} from "@claxedo/sandbox-manager"
import { WORKSPACE_DIR } from "@claxedo/sandbox-manager/defaults"
import { trimToUndefined } from "@claxedo/helpers/string"
import { normalizeClaxedoRegion } from "@claxedo/server-core/platform/runtime/region/index"
import { configuredRelayUrl, type WorkspaceRouteOptions, type WorkspaceRuntimePreparation } from "./route-support"

/** The deployment facts a hosted workspace's egress policy is assembled from. */
export type WorkspaceSandboxEgress = Pick<
  WorkspaceRouteOptions,
  "relayUrl" | "relayUrls" | "defaultHomeRegion" | "sandboxEgressExtraHosts" | "sandboxControlPlaneOrigin"
>

/** The stored workspace row a hosted sandbox is provisioned from, as the authority reports it. */
export type HostedWorkspaceRow = {
  workspace_id?: unknown
  project_id?: unknown
  home_region?: unknown
  repo_url?: unknown
  git_branch?: unknown
  remote_directory?: unknown
}

function rowSource(row: HostedWorkspaceRow): SandboxSource {
  const repoUrl = trimToUndefined(row.repo_url)
  const branch = trimToUndefined(row.git_branch)
  return repoUrl ? { kind: "git", repoUrl, ...(branch ? { branch } : {}) } : { kind: "empty" }
}

/**
 * The whole ensure input of a hosted workspace's sandbox, rebuilt from its
 * row by every site that ensures one: the create, a connection, a Tasks
 * cloud root, and a refresh of a running sandbox. A driver that re-creates
 * its host boots it from exactly this input, so a field left off one site
 * comes back missing: no source or root, no project label, no tool-group
 * consent (`env`), or unrestricted egress (`net`).
 *
 * `secrets` joins the caller's own brokered secrets to the preparation's; an
 * absent pair says nothing about the installed set, while an empty one
 * withdraws it.
 */
export function hostedSandboxInput(
  row: HostedWorkspaceRow,
  input: {
    egress: WorkspaceSandboxEgress
    preparation: WorkspaceRuntimePreparation | undefined
    secrets?: readonly SandboxBrokeredSecret[]
    onLeaseOpened?: () => void
  },
): SandboxManagerInput {
  const projectId = trimToUndefined(row.project_id)
  if (!projectId) throw new Error(`workspace ${String(row.workspace_id)} has no project to label its sandbox with`)
  const homeRegion = normalizeClaxedoRegion(row.home_region, input.egress.defaultHomeRegion)
  const source = rowSource(row)
  const secrets = input.secrets !== undefined || input.preparation?.secrets !== undefined
    ? [...input.secrets ?? [], ...input.preparation?.secrets ?? []]
    : undefined
  return {
    homeRegion,
    labels: { projectId },
    workspaceRoot: trimToUndefined(row.remote_directory) ?? WORKSPACE_DIR,
    source,
    ...(secrets !== undefined ? { secrets } : {}),
    ...(input.preparation?.env ? { env: input.preparation.env } : {}),
    ...(input.onLeaseOpened ? { onLeaseOpened: input.onLeaseOpened } : {}),
    net: hostedSandboxNetworkPolicy({
      controlPlane: [configuredRelayUrl(input.egress, homeRegion), input.egress.sandboxControlPlaneOrigin],
      source,
      ...(input.egress.sandboxEgressExtraHosts ? { extraHosts: input.egress.sandboxEgressExtraHosts } : {}),
    }),
  }
}
