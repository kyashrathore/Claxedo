import { placementId, projectId } from "../ids"
import type { CloudWorkspace, CloudWorkspaceStatus, CodeHostRepository } from "../cloud-types"
import { isRecord, nonEmptyString } from "@claxedo/helpers/guards"
import { cloudWorkspaceName } from "./workspace-name"

function cloudStatusFromWire(status: unknown, step?: unknown, message?: unknown): CloudWorkspaceStatus {
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
    case "stopped":
      return { kind: "stopped" }
    case "error":
    case "failed":
      return { kind: "failed", reason: nonEmptyString(message) ?? "The cloud workspace failed" }
    default:
      return { kind: "failed", reason: `The cloud workspace reports an unknown status: ${String(status)}` }
  }
}

export function provisionStatus(frame: Record<string, unknown>): CloudWorkspaceStatus {
  const step = frame.step
  if (step === "ready") return { kind: "ready" }
  if (step === "error") return { kind: "failed", reason: nonEmptyString(frame.message) ?? "Provisioning failed" }
  return { kind: "provisioning", step: nonEmptyString(step) ?? "provisioning" }
}

export function cloudWorkspaceFromRow(row: unknown): CloudWorkspace | undefined {
  if (!isRecord(row) || row.backing === "local-worktree") return undefined
  const id = nonEmptyString(row.workspace_id) ?? nonEmptyString(row.workspaceId)
  const owner = nonEmptyString(row.project_id) ?? nonEmptyString(row.projectId)
  if (!id || !owner) return undefined
  const branch = nonEmptyString(row.git_branch) ?? nonEmptyString(row.gitBranch) ?? nonEmptyString(row.branch)
  return {
    id: placementId(id),
    projectId: projectId(owner),
    name: cloudWorkspaceName(row, id, branch),
    ...(branch ? { branch } : {}),
    status: cloudStatusFromWire(row.status, row.step, row.error),
  }
}

export function codeHostRepositoryFromRow(row: unknown): CodeHostRepository | undefined {
  if (!isRecord(row)) return undefined
  const id = nonEmptyString(row.id)
  const fullName = nonEmptyString(row.fullName)
  return id && fullName ? { id, fullName, private: row.private === true } : undefined
}
