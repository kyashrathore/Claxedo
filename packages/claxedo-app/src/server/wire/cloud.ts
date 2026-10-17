import { placementId, projectId } from "../ids"
import type {
  CloudStopOutcome,
  CloudWorkspace,
  CloudWorkspaceStatus,
  CodeHostAppInstallation,
  CodeHostRepository,
  CodeHostRepositoryAccess,
  CodeHostRepositoryListing,
} from "../cloud-types"
import { isRecord, nonEmptyString } from "@claxedo/helpers/guards"
import { isCheckpointUnusableRow } from "./connection"
import { cloudWorkspaceName } from "./workspace-name"

function cloudStatusFromRow(row: Record<string, unknown>): CloudWorkspaceStatus {
  const { status, step } = row
  switch (status) {
    case "provisioning":
    case "acquiring_sandbox":
    case "cloning":
    case "starting_runtime":
    case "waiting_health":
      return { kind: "provisioning", step: nonEmptyString(step) ?? (typeof status === "string" ? status : "provisioning") }
    case "starting":
      return { kind: "starting" }
    case "ready":
    case "running":
    case "active":
      return { kind: "ready" }
    case "stopping":
      return { kind: "stopping" }
    case "stopped": {
      const reason = nonEmptyString(row.stopReason)
      return { kind: "stopped", ...(reason ? { reason } : {}) }
    }
    case "error":
    case "failed":
      return { kind: "failed", reason: nonEmptyString(row.error) ?? "The cloud workspace failed", ...(isCheckpointUnusableRow(row) ? { checkpointUnusable: true } : {}) }
    default:
      return { kind: "failed", reason: `The cloud workspace reports an unknown status: ${String(status)}` }
  }
}

export function provisionStatus(frame: Record<string, unknown>): CloudWorkspaceStatus {
  const step = frame.step
  if (step === "ready") return { kind: "ready" }
  if (step === "stopped") return { kind: "stopped" }
  if (step === "error") return { kind: "failed", reason: nonEmptyString(frame.message) ?? "Provisioning failed" }
  return { kind: "provisioning", step: nonEmptyString(step) ?? "provisioning" }
}

export function cloudWorkspaceFromRow(row: unknown): CloudWorkspace | undefined {
  if (!isRecord(row) || row.backing === "local-worktree") return undefined
  const id = nonEmptyString(row.workspace_id) ?? nonEmptyString(row.workspaceId)
  const owner = nonEmptyString(row.project_id) ?? nonEmptyString(row.projectId)
  if (!id || !owner) return undefined
  const branch = nonEmptyString(row.git_branch) ?? nonEmptyString(row.gitBranch) ?? nonEmptyString(row.branch)
  const name = cloudWorkspaceName(row, id)
  return {
    id: placementId(id),
    projectId: projectId(owner),
    ...(name ? { name } : {}),
    ...(branch ? { branch } : {}),
    status: cloudStatusFromRow(row),
  }
}

function codeHostRepositoryFromRow(row: unknown): CodeHostRepository | undefined {
  if (!isRecord(row)) return undefined
  const id = nonEmptyString(row.id)
  const fullName = nonEmptyString(row.fullName)
  return id && fullName ? { id, fullName, private: row.private === true } : undefined
}

export function httpsLink(value: unknown) {
  const link = nonEmptyString(value)
  return link && URL.canParse(link) && new URL(link).protocol === "https:" ? link : undefined
}

function installationFromWire(value: unknown): CodeHostAppInstallation | undefined {
  if (!isRecord(value)) return undefined
  const account = nonEmptyString(value.account)
  const settingsUrl = httpsLink(value.settingsUrl)
  const selection = value.repositorySelection
  return account && settingsUrl && (selection === "all" || selection === "selected")
    ? { account, settingsUrl, repositorySelection: selection }
    : undefined
}

function repositoryAccessFromWire(value: unknown): CodeHostRepositoryAccess | undefined {
  if (!isRecord(value)) return undefined
  if (value.kind === "token") {
    const settingsUrl = httpsLink(value.settingsUrl)
    return settingsUrl ? { kind: "token", settingsUrl } : undefined
  }
  if (value.kind !== "app" || !Array.isArray(value.installations)) return undefined
  return { kind: "app", installations: value.installations.flatMap((row) => installationFromWire(row) ?? []) }
}

export function cloudStopOutcomeFromBody(body: unknown): CloudStopOutcome {
  return { unsaved: isRecord(body) && body.unsaved === true }
}

export function codeHostRepositoryListingFromBody(body: unknown): CodeHostRepositoryListing {
  const record = isRecord(body) ? body : {}
  const rows: unknown[] = Array.isArray(record.repositories) ? record.repositories : []
  const access = repositoryAccessFromWire(record.access)
  return {
    repositories: rows.flatMap((row) => codeHostRepositoryFromRow(row) ?? []),
    ...(access ? { access } : {}),
  }
}
