import type { SandboxBrokeredSecret } from "@claxedo/sandbox-manager"
import { WORKSPACE_DIR } from "@claxedo/sandbox-manager/defaults"
import { sha256Hex } from "@claxedo/helpers/crypto"
import { ensureHostForRepo } from "@claxedo/server-core/sandbox/network/policy"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import {
  deleteWorkspace,
  getProjectWorkspace,
  getWorkspace,
  ensureWorkspace,
  projectEnv,
  type Workspace,
} from "@claxedo/server-core/workspace/store/index"
import type { ControlPlaneServices } from "../authority/services"

const log = Log.create({ service: "origin-cloud-workspace" })

/**
 * How long a caller waits for a first provision before it is told to ask
 * again. The allocation is recoverable by construction, so a wait that
 * outlives a request budget is worse than a refusal: the next call for the
 * same origin key finds the same workspace still provisioning and picks the
 * wait up where this one left it.
 */
const READY_DEADLINE_MS = 30_000
const READY_POLL_CAP_MS = 2_000

export type OriginCloudWorkspaceRefusal = {
  code: "placement_unsupported" | "source_unavailable"
  detail: string
}

export type OriginCloudWorkspaceResult = { workspace: Workspace } | OriginCloudWorkspaceRefusal

export type OriginCloudWorkspaceInput = {
  services: Pick<ControlPlaneServices, "sandbox" | "defaultHomeRegion">
  /**
   * The root this workspace belongs to. The workspace id is derived from these
   * bytes and from nothing else, which is the whole of the association: two
   * keys cannot reach one workspace, and one key reaches its own after a
   * process loss with nothing persisted to look the mapping up in.
   */
  originKey: string
  /** The project whose authorized remote and environment this root clones. */
  projectId: string
  displayName: string
  /**
   * Records the allocation with the deployment's workspace authority, as the
   * caller. A deployment whose authority never learns of the workspace can
   * neither reserve a session in it nor let the caller open one.
   */
  admit(workspace: Workspace): Promise<void>
  /**
   * Undo of `admit`, for a workspace whose sandbox definitely failed. Left
   * behind, the authority's row outlives the store's and the next attempt at
   * the same key re-admits against a row it must match exactly.
   */
  discard(workspace: Workspace): Promise<void>
  /**
   * Credentials this root's own configuration needs, resolved once the
   * workspace id exists and before the sandbox is created.
   *
   * They ride the driver's brokered-secret channel, which only `ensure`
   * reaches, so a caller that resolved them after readiness would have a
   * runtime that can never be given them.
   */
  prepare?(workspace: Workspace): Promise<readonly SandboxBrokeredSecret[]>
}

/**
 * `ws_<24 hex of SHA-256(originKey)>`.
 *
 * 27 characters of `[a-z0-9_]`, inside the ~28-character ceiling that driver
 * resource names impose on a workspace id (see `newWorkspaceId`). Unguessable
 * to the extent the origin key is: a Tasks key carries a `tsk_<uuid>`, so
 * guessing this id means already knowing the task it belongs to.
 */
export async function originCloudWorkspaceId(originKey: string): Promise<string> {
  return `ws_${(await sha256Hex(originKey)).slice(0, 24)}`
}

/**
 * The dedicated cloud workspace one origin key runs in, provisioned and ready.
 *
 * Retries of the same key recover the same workspace rather than allocating a
 * second: the id is a function of the key, so the store's own row is the
 * receipt. A provision that definitely failed removes that row, which is what
 * lets the next attempt start over instead of waiting on a sandbox nothing
 * will ever finish.
 */
export async function allocateOriginCloudWorkspace(
  input: OriginCloudWorkspaceInput,
): Promise<OriginCloudWorkspaceResult> {
  const sandboxManager = input.services.sandbox.sandboxManager
  if (!sandboxManager) {
    return {
      code: "placement_unsupported",
      detail: "No cloud sandbox driver is configured on this control plane",
    }
  }

  const workspaceId = await originCloudWorkspaceId(input.originKey)
  const stored = await getWorkspace(workspaceId)
  const workspace = stored ? await admit(stored, input) : await allocate(workspaceId, input)
  if (!("id" in workspace)) return workspace

  const repoUrl = workspace.repo_url ?? workspace.git_remote
  if (!repoUrl) {
    return { code: "source_unavailable", detail: `Cloud root ${workspace.id} has no remote to clone` }
  }
  ensureHostForRepo(repoUrl)

  const secrets = (await input.prepare?.(workspace)) ?? []
  const ready = await awaitSandboxReady(sandboxManager, workspace, {
    homeRegion: input.services.defaultHomeRegion ?? "us-east",
    projectId: input.projectId,
    repoUrl,
    env: (await projectEnv(input.projectId)) ?? {},
    secrets,
  })
  if (ready.status === "ready") return { workspace }
  if (ready.status === "provisioning") {
    return {
      code: "source_unavailable",
      detail: "The cloud workspace for this attempt is still being provisioned; start it again in a moment",
    }
  }

  log.warn("Origin cloud workspace provisioning failed", { workspaceId: workspace.id, error: ready.error })
  await sandboxManager.release(workspace.id).catch(() => undefined)
  await input.discard(workspace).catch(() => undefined)
  await deleteWorkspace(workspace.id).catch(() => undefined)
  return {
    code: "source_unavailable",
    detail: ready.error
      ? `The cloud workspace for this attempt could not be provisioned: ${ready.error}`
      : "The cloud workspace for this attempt could not be provisioned",
  }
}

/**
 * The row for a key that has none yet.
 *
 * Its own id is its project id. A cloud root that carried the source project's
 * id would join that project's workspace list, where a later Start with no
 * workspace preference has to choose between them by name — so allocating one
 * root would refuse the next ordinary Start in the same project.
 */
async function allocate(
  workspaceId: string,
  input: OriginCloudWorkspaceInput,
): Promise<Workspace | OriginCloudWorkspaceRefusal> {
  const root = await getProjectWorkspace(input.projectId)
  const repoUrl = root?.git_remote ?? root?.repo_url
  if (!root || !repoUrl) {
    return {
      code: "source_unavailable",
      detail: `Project ${input.projectId} has no remote this control plane can clone into an isolated cloud root`,
    }
  }
  const workspace = await ensureWorkspace({
    workspaceId,
    ...(root.org_id ? { org_id: root.org_id } : {}),
    ...(root.project_name ? { project_name: root.project_name } : {}),
    workspace_name: input.displayName,
    directory: WORKSPACE_DIR,
    kind: "cloud",
    ...(input.services.sandbox.defaultDriver ? { driver: input.services.sandbox.defaultDriver } : {}),
    repo_url: repoUrl,
    ...(root.git_branch ? { git_branch: root.git_branch } : {}),
    remote_directory: WORKSPACE_DIR,
    status: "acquiring_sandbox",
  })
  if (!workspace) {
    return { code: "source_unavailable", detail: "The cloud workspace for this attempt could not be stored" }
  }
  return await admit(workspace, input)
}

/**
 * Records the row with the authority, on every attempt rather than only on the
 * one that stored it.
 *
 * The store row cannot stand in for the authority's: a provision that failed
 * discards the authority row and then deletes the store row, and that delete
 * is best-effort. Re-admitting a row this attempt found is what keeps a
 * survivor of that path from being a workspace the authority has never heard
 * of, whose every later reservation is refused with no way back.
 */
async function admit(
  workspace: Workspace,
  input: OriginCloudWorkspaceInput,
): Promise<Workspace | OriginCloudWorkspaceRefusal> {
  try {
    await input.admit(workspace)
  } catch (error) {
    await deleteWorkspace(workspace.id).catch(() => undefined)
    return {
      code: "source_unavailable",
      detail: `This caller may not create a cloud workspace here: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  return workspace
}

type SandboxLifecycle = NonNullable<ControlPlaneServices["sandbox"]["sandboxManager"]>

async function awaitSandboxReady(
  sandboxManager: SandboxLifecycle,
  workspace: Workspace,
  run: {
    homeRegion: string
    projectId: string
    repoUrl: string
    env: Record<string, string>
    secrets: readonly SandboxBrokeredSecret[]
  },
) {
  const deadline = Date.now() + READY_DEADLINE_MS
  for (;;) {
    const result = await sandboxManager.ensure(workspace.id, {
      homeRegion: run.homeRegion,
      labels: { projectId: run.projectId },
      workspaceRoot: workspace.remote_directory ?? WORKSPACE_DIR,
      ...(Object.keys(run.env).length ? { env: run.env } : {}),
      ...(run.secrets.length ? { secrets: [...run.secrets] } : {}),
      source: { kind: "git", repoUrl: run.repoUrl, ...(workspace.git_branch ? { branch: workspace.git_branch } : {}) },
    })
    if (result.status !== "provisioning") return result
    if (Date.now() >= deadline) return result
    await new Promise((resolve) => setTimeout(resolve, Math.min(result.retryAfterMs, READY_POLL_CAP_MS)))
  }
}
