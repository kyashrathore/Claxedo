import { sandboxStartFailureReason, type SandboxDriver } from "@claxedo/sandbox-manager"
import { WORKSPACE_DIR } from "@claxedo/sandbox-manager/defaults"
import { isSandboxDriverID } from "@claxedo/sandbox-contract"
import { sha256Hex } from "@claxedo/helpers/crypto"
import { isClaxedoError } from "@claxedo/server-core/platform/errors/base"
import { cloudRuntimeStartFailure } from "@claxedo/server-core/workspace/cloud-runtime-readiness"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import type { ControlPlaneServices } from "../authority/services"
import type { CloudStartOutcome } from "./cloud-workspace-start"

const log = Log.create({ service: "origin-cloud-workspace" })

export type OriginCloudWorkspaceRefusal = {
  code: "placement_unsupported" | "source_unavailable" | "capability_unavailable"
  detail: string
}

/** A root filed and started: `running` once its sandbox serves, `starting` while its start is under way. */
export type OriginCloudWorkspaceResult = { workspace: Workspace; state: "running" | "starting" } | OriginCloudWorkspaceRefusal

/** The repository and ref a project's cloud roots clone. */
export type OriginCloudSource = { repoUrl: string; gitBranch?: string; repoName?: string }

/** The deployment's workspace rows, where the row `admit` files is the only record of a root. */
export type OriginCloudWorkspaceRows = {
  workspace(workspaceId: string): Promise<Workspace | undefined>
  projectSource(projectId: string): Promise<OriginCloudSource | undefined>
}

/** What names one origin's root, and what a root the key has none for yet would be filed as. */
export type OriginCloudRootInput = {
  services: Pick<ControlPlaneServices, "sandbox">
  rows: OriginCloudWorkspaceRows
  /**
   * The root this workspace belongs to. The workspace id is derived from these
   * bytes and from nothing else, which is the whole of the association: two
   * keys cannot reach one workspace, and one key reaches its own after a
   * process loss with nothing persisted to look the mapping up in.
   */
  originKey: string
  /** The project whose authorized remote this root clones, and the project it is filed in. */
  projectId: string
  /** The organization the root is created in, whose sandbox provider key places it. */
  orgId: string
  displayName: string
}

export type OriginCloudWorkspaceInput = OriginCloudRootInput & {
  /**
   * Files the root with the deployment's workspace authority, as the caller,
   * or re-admits the row an earlier attempt filed. The authority holds a
   * second filing of one id to the first exactly, owner included, so a retry
   * by anyone but the root's creator is refused rather than handed their
   * workspace.
   */
  admit(workspace: Workspace): Promise<void>
  /** The workspace's one sandbox start: it begins the run or joins the one in flight, and answers at once. */
  start(workspace: Workspace): Promise<CloudStartOutcome>
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
 * The root one origin key has, or the one it would be filed as, read without
 * filing or starting anything: the row an earlier attempt filed, or the
 * project's source at its ref on the driver its organization's key builds.
 */
export async function originCloudRoot(input: OriginCloudRootInput): Promise<Workspace | OriginCloudWorkspaceRefusal> {
  if (!input.services.sandbox.sandboxManager) {
    return { code: "placement_unsupported", detail: "This control plane provisions no cloud sandboxes" }
  }
  const workspaceId = await originCloudWorkspaceId(input.originKey)
  return (await input.rows.workspace(workspaceId)) ?? newRoot(workspaceId, input)
}

/**
 * The dedicated cloud workspace one origin key runs in, filed and started
 * through the workspace's own sandbox start, which announces the start to the
 * owner's open clients and drives it to ready in the background.
 *
 * Retries of the same key recover the same workspace rather than allocating a
 * second: the id is a function of the key, so the authority's row is the
 * receipt, and the start a retry asks for joins the run in flight or finds the
 * sandbox serving.
 */
export async function allocateOriginCloudWorkspace(input: OriginCloudWorkspaceInput): Promise<OriginCloudWorkspaceResult> {
  const workspace = await originCloudRoot(input)
  if (!("id" in workspace)) return workspace
  try {
    await input.admit(workspace)
  } catch (error) {
    return {
      code: "source_unavailable",
      detail: `This caller may not create a cloud workspace here: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (!workspace.repo_url) {
    return { code: "source_unavailable", detail: "The task's cloud workspace has no repository to clone" }
  }
  const started = await input.start(workspace)
  if ("denied" in started) return { code: "source_unavailable", detail: started.denied.error.message }
  if (started.status === "ready") return { workspace, state: "running" }
  if (started.status === "provisioning") return { workspace, state: "starting" }
  if (started.status === "failed") {
    log.warn("Origin cloud workspace preparation failed", { workspaceId: workspace.id, code: started.code, error: started.message })
    return { code: "capability_unavailable", detail: "The task's plugins and skills could not be set up for this start." }
  }
  log.warn("Origin cloud workspace start failed", { workspaceId: workspace.id, error: started.error })
  return {
    code: "source_unavailable",
    detail: started.error ? cloudRuntimeStartFailure(sandboxStartFailureReason(started.error)) : "The cloud workspace could not start",
  }
}

/** An organization without a key has no placement to offer. */
async function newRoot(workspaceId: string, input: OriginCloudRootInput): Promise<Workspace | OriginCloudWorkspaceRefusal> {
  const source = await input.rows.projectSource(input.projectId)
  if (!source) {
    return {
      code: "source_unavailable",
      detail: "This project has no repository to clone into a cloud workspace",
    }
  }
  let placed: SandboxDriver | undefined
  try {
    placed = await input.services.sandbox.orgDriver?.(input.orgId)
  } catch (error) {
    if (!isClaxedoError(error) || error.code !== "sandbox_provider_key_missing") throw error
    return { code: "placement_unsupported", detail: error.message }
  }
  if (!placed || !isSandboxDriverID(placed.id)) {
    return {
      code: "placement_unsupported",
      detail: "This control plane's sandbox provisioner is not one a workspace placement can name",
    }
  }
  const now = Date.now()
  return {
    id: workspaceId,
    org_id: input.orgId,
    project_id: input.projectId,
    workspace_name: input.displayName,
    directory: WORKSPACE_DIR,
    kind: "cloud",
    repo_url: source.repoUrl,
    ...(source.repoName ? { repo_name: source.repoName } : {}),
    ...(source.gitBranch ? { git_branch: source.gitBranch } : {}),
    remote_directory: WORKSPACE_DIR,
    created_at: now,
    updated_at: now,
  }
}
