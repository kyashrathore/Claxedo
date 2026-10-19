import { requireAuthority, type WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { StartBlocker } from "@claxedo/tasks"
import type { TasksCloudRootCreator, TasksCloudRootRequest, TasksCloudRoots } from "@claxedo/tasks/hosted"
import type { ControlPlaneServices } from "../../../authority/services"
import {
  createCloudCreateAdmission,
  type CloudCreateAdmission,
  type CloudCreateCaller,
  type CloudCreateUsage,
} from "../../../workspace/cloud-create-admission"
import { startCloudWorkspace } from "../../../workspace/cloud-workspace-start"
import {
  allocateOriginCloudWorkspace,
  originCloudRoot,
  originCloudWorkspaceId,
  type OriginCloudRootInput,
  type OriginCloudWorkspaceRows,
} from "../../../workspace/origin-cloud-workspace"
import type { SandboxStart } from "../../../workspace/sandbox-start"

export type HostedTasksCloudRootsInput = {
  services: ControlPlaneServices
  rows: OriginCloudWorkspaceRows
  /**
   * The workspace's one sandbox start, the same one a person's connect begins:
   * it takes the lease, announces the start to the owner's open clients and
   * drives the sandbox to ready in the background, preparing every step with
   * the capability set the start names (the owner's accounts, the project's
   * environment, the root's Tasks grant and its selected plugins and skills).
   * A deployment that names none cannot start a cloud root, and a cloud Start
   * is refused before anything is filed.
   */
  sandboxStart?: SandboxStart
  /**
   * The admission a cloud root's create passes through — the same gates `POST
   * /api/workspace/create` applies, keyed on whoever the root is created as.
   * Without one a root still runs the authority's own create admission and a
   * create budget that lives as long as these roots; the product gates —
   * entitlement, a create bucket shared with the route, the lease cap's
   * counter — arrive only through the deployment's composition.
   */
  cloudCreateAdmission?: CloudCreateAdmission
  /**
   * The usage side effects a workspace's first explicit start runs on the
   * lease it opens, fired identically for a task-driven root: the event that makes the
   * spend attributable and the tenant stamp the concurrency cap counts.
   * Absent, a root's lease is created but unattributed, which is exactly what
   * leaves it invisible to the cap.
   */
  sandboxUsage?: CloudCreateUsage
}

type RootWorkspaceArgs = {
  workspaceId: string
  projectId: string
  displayName: string
  repoUrl?: string
  repoName?: string
  gitBranch?: string
  remoteDirectory?: string
  homeRegion?: string
}

/** The identity create admission runs against, and the authority door the root is filed through. */
type RootFiler = {
  caller: CloudCreateCaller
  admit(authority: WorkspaceAuthority, args: RootWorkspaceArgs): Promise<void>
}

const UNSTARTABLE: StartBlocker = { code: "placement_unsupported", detail: "This control plane cannot start a cloud root" }

/**
 * A signed caller files the root as themselves. An owner is filed by
 * canonical actor through the authority's runtime-principal path, in the
 * owner's organization, which is the actor's scope and the authoritative one.
 */
function rootFiler(creator: TasksCloudRootCreator): RootFiler {
  if (creator.kind === "signed") {
    const { auth } = creator
    return {
      caller: { kind: "signed", auth },
      admit: (authority, args) => authority.createCloudWorkspace(auth, args).then(() => undefined),
    }
  }
  const { owner } = creator
  const principal = { principalKind: "user", actorId: owner.actorId, actorKind: "human" } as const
  return {
    caller: { kind: "owner", owner: { userId: owner.userId, orgId: owner.orgId } },
    admit: async (authority, args) => {
      if (!authority.createRuntimeCloudWorkspace) {
        throw new Error("this control plane cannot create a cloud root for a session's grant")
      }
      await authority.createRuntimeCloudWorkspace(principal, { ...args, orgId: owner.orgId })
    },
  }
}

/** The Tasks plugin's cloud roots over this deployment's workspace authority, admission and sandbox start. */
export function createHostedTasksCloudRoots(input: HostedTasksCloudRootsInput): TasksCloudRoots {
  const { services } = input
  const admission = input.cloudCreateAdmission ?? createCloudCreateAdmission({ services })
  const rootOf = (root: TasksCloudRootRequest): OriginCloudRootInput => ({ services, rows: input.rows, ...root })
  return {
    refusal: async (root) => {
      const existing = await originCloudRoot(rootOf(root))
      if (!("id" in existing)) return { code: existing.code, detail: existing.detail }
      return input.sandboxStart ? undefined : UNSTARTABLE
    },
    allocate: async (root, creator, capabilities) => {
      const start = input.sandboxStart
      const sandboxManager = services.sandbox.sandboxManager
      if (!start || !sandboxManager) return { blocker: UNSTARTABLE }
      const filer = creator ? rootFiler(creator) : undefined
      // The create route's own admission, before a row or a sandbox exists: the
      // create budget, the authority's create admission, the deployment's
      // cloud-workspace admission, and the concurrent-lease cap. A caller nobody resolved keeps
      // its refusal inside `admit` below, where it always was. `existing` marks
      // the retry of a root that already holds its lease: that lease is the
      // cap's own, so the cap does not count it a second time. A root with no
      // row yet has no lease, and a deployment's manager cannot place a
      // workspace its authority has never heard of to look one up.
      if (filer) {
        const rootId = await originCloudWorkspaceId(root.originKey)
        const lease = await input.rows.workspace(rootId) ? await sandboxManager.target(rootId) : undefined
        const existing = lease !== undefined && !(lease.status === "unavailable" && lease.reason === "runtime_lease_missing")
        const admitted =
          await admission.preflight(filer.caller) ??
          await admission.admit(filer.caller, { projectId: root.projectId }, { existing })
        if ("status" in admitted) {
          const code = admitted.body.error.code === "control_plane_rate_limited" ? "rate_limited" : "source_unavailable"
          return { blocker: { code, detail: admitted.body.error.message } }
        }
      }
      const allocated = await allocateOriginCloudWorkspace({
        ...rootOf(root),
        admit: async (workspace) => {
          if (!filer) {
            throw new Error(
              "this host creates a cloud root as the person starting it, and this caller is neither signed nor a grant this host resolved to an owner",
            )
          }
          await filer.admit(requireAuthority(services), {
            workspaceId: workspace.id,
            projectId: root.projectId,
            displayName: workspace.workspace_name ?? workspace.id,
            ...(workspace.repo_url ? { repoUrl: workspace.repo_url } : {}),
            ...(workspace.repo_name ? { repoName: workspace.repo_name } : {}),
            ...(workspace.git_branch ? { gitBranch: workspace.git_branch } : {}),
            ...(workspace.remote_directory ? { remoteDirectory: workspace.remote_directory } : {}),
            ...(services.defaultHomeRegion ? { homeRegion: services.defaultHomeRegion } : {}),
          })
        },
        // A Start asks for this root anew, so a failure held from its last
        // start does not answer it.
        start: async (workspace) => {
          if (!filer) throw new Error("a cloud root is started only after its creator filed it")
          return startCloudWorkspace(services, start, { admission, usage: input.sandboxUsage }, filer.caller, {
            workspaceId: workspace.id,
            orgId: root.orgId,
            ...(services.defaultHomeRegion ? { homeRegion: services.defaultHomeRegion } : {}),
            current: await sandboxManager.target(workspace.id),
            request: { retry: true, capabilities },
          })
        },
      })
      if ("code" in allocated) return { blocker: { code: allocated.code, detail: allocated.detail } }
      if (allocated.state === "starting") return { preparing: { workspaceId: allocated.workspace.id } }
      return { workspace: allocated.workspace }
    },
  }
}
