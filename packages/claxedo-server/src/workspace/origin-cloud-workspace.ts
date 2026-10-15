import { sandboxStartFailureReason, type SandboxBrokeredSecret, type SandboxDriver, type SandboxManagerInput } from "@claxedo/sandbox-manager"
import { WORKSPACE_DIR } from "@claxedo/sandbox-manager/defaults"
import { isSandboxDriverID } from "@claxedo/sandbox-contract"
import { sha256Hex } from "@claxedo/helpers/crypto"
import { isClaxedoError } from "@claxedo/server-core/platform/errors/base"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import type { ControlPlaneServices } from "../authority/services"
import { hostedSandboxInput, type WorkspaceSandboxEgress } from "./hosted-sandbox-input"

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

/** The repository and ref a project's cloud roots clone. */
export type OriginCloudSource = { repoUrl: string; gitBranch?: string; repoName?: string }

/** The deployment's workspace rows, where the row `admit` files is the only record of a root. */
export type OriginCloudWorkspaceRows = {
  workspace(workspaceId: string): Promise<Workspace | undefined>
  projectSource(projectId: string): Promise<OriginCloudSource | undefined>
}

export type OriginCloudWorkspaceInput = {
  services: Pick<ControlPlaneServices, "sandbox" | "defaultHomeRegion">
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
  /**
   * What every hosted root's egress allowlist is built from besides the git
   * host this allocation clones: the deployment's relays and extra hosts, and
   * the control-plane origin the runtime reports back to.
   */
  egress: WorkspaceSandboxEgress
  /**
   * Files the root with the deployment's workspace authority, as the caller,
   * or re-admits the row an earlier attempt filed. The authority holds a
   * second filing of one id to the first exactly, owner included, so a retry
   * by anyone but the root's creator is refused rather than handed their
   * workspace. The context says whether the ensure that follows opens the
   * root's lease, so the metering a first lease runs fires once per lease and
   * not once per retry.
   */
  admit(workspace: Workspace, context: OriginCloudAdmission): Promise<void>
  /**
   * What this root's own configuration needs, resolved once the workspace id
   * exists and before the sandbox is created.
   *
   * Brokered secrets ride the driver's egress-injection channel and never
   * enter the sandbox; `env` is the readable environment, for a credential the
   * agent itself presents. Both reach a runtime only through `ensure`, so a
   * caller that resolved them after readiness would have a runtime that can
   * never be given them.
   */
  prepare?(workspace: Workspace): Promise<OriginCloudWorkspacePreparation>
}

/** A root whose lease the next ensure opens names the driver that lease runs on. */
export type OriginCloudAdmission = { opensLease: true; driver: string } | { opensLease: false }

export type OriginCloudWorkspacePreparation = Readonly<{
  secrets?: readonly SandboxBrokeredSecret[]
  env?: Readonly<Record<string, string>>
}>

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
 * second: the id is a function of the key, so the authority's row is the
 * receipt. A provision that definitely failed releases the lease and keeps
 * the row, so the next attempt re-admits it and starts a fresh sandbox
 * instead of waiting on one nothing will ever finish. The row is not
 * discarded: the authority never files a deleted id again, so a discarded
 * root's attempt could never be started.
 */
export async function allocateOriginCloudWorkspace(
  input: OriginCloudWorkspaceInput,
): Promise<OriginCloudWorkspaceResult> {
  const sandboxManager = input.services.sandbox.sandboxManager
  if (!sandboxManager) {
    return {
      code: "placement_unsupported",
      detail: "This control plane provisions no cloud sandboxes",
    }
  }

  const workspaceId = await originCloudWorkspaceId(input.originKey)
  const stored = await input.rows.workspace(workspaceId)
  const workspace = stored
    ? await admit(stored, input, await storedRootLease(input, sandboxManager, workspaceId))
    : await allocate(workspaceId, input)
  if (!("id" in workspace)) return workspace

  const repoUrl = workspace.repo_url
  if (!repoUrl) {
    return { code: "source_unavailable", detail: `Cloud root ${workspace.id} has no remote to clone` }
  }

  const prepared = (await input.prepare?.(workspace)) ?? {}
  const ready = await awaitSandboxReady(sandboxManager, workspace.id, hostedSandboxInput({
    workspace_id: workspace.id,
    project_id: input.projectId,
    home_region: input.services.defaultHomeRegion,
    repo_url: repoUrl,
    git_branch: workspace.git_branch,
    remote_directory: workspace.remote_directory,
  }, {
    egress: input.egress,
    preparation: { env: { ...prepared.env }, secrets: [...prepared.secrets ?? []] },
  }))
  if (ready.status === "ready") return { workspace }
  if (ready.status === "provisioning") {
    return {
      code: "source_unavailable",
      detail: "The cloud workspace for this attempt is still being provisioned; start it again in a moment",
    }
  }

  log.warn("Origin cloud workspace provisioning failed", { workspaceId: workspace.id, error: ready.error })
  await sandboxManager.release(workspace.id).catch(() => undefined)
  return {
    code: "source_unavailable",
    detail: ready.error
      ? `The cloud workspace for this attempt could not be provisioned: ${sandboxStartFailureReason(ready.error)}`
      : "The cloud workspace for this attempt could not be provisioned",
  }
}

/**
 * The root for a key that has none yet: the project's source at its ref,
 * filed in the task's project, on the driver its organization's key builds.
 * An organization without a key has no placement to offer.
 */
async function allocate(
  workspaceId: string,
  input: OriginCloudWorkspaceInput,
): Promise<Workspace | OriginCloudWorkspaceRefusal> {
  const source = await input.rows.projectSource(input.projectId)
  if (!source) {
    return {
      code: "source_unavailable",
      detail: `Project ${input.projectId} has no remote this control plane can clone into an isolated cloud root`,
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
  const workspace: Workspace = {
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
  return await admit(workspace, input, { opensLease: true, driver: placed.id })
}

/** A stored root whose lease a failed provision released opens a new one, on the driver its workspace is placed on. */
async function storedRootLease(
  input: OriginCloudWorkspaceInput,
  sandboxManager: SandboxLifecycle,
  workspaceId: string,
): Promise<OriginCloudAdmission> {
  const current = await sandboxManager.target(workspaceId)
  if (current.status !== "unavailable" || current.reason !== "runtime_lease_missing") return { opensLease: false }
  const placed = await input.services.sandbox.workspaceDriver?.(workspaceId)
  return { opensLease: true, driver: placed?.id ?? "unknown" }
}

async function admit(
  workspace: Workspace,
  input: OriginCloudWorkspaceInput,
  context: OriginCloudAdmission,
): Promise<Workspace | OriginCloudWorkspaceRefusal> {
  try {
    await input.admit(workspace, context)
  } catch (error) {
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
  workspaceId: string,
  run: SandboxManagerInput,
) {
  const deadline = Date.now() + READY_DEADLINE_MS
  for (;;) {
    const result = await sandboxManager.ensure(workspaceId, run)
    if (result.status !== "provisioning") return result
    if (Date.now() >= deadline) return result
    await new Promise((resolve) => setTimeout(resolve, Math.min(result.retryAfterMs, READY_POLL_CAP_MS)))
  }
}
