import { placementId, projectId } from "../ids"
import type { CloudWorkspace, CloudWorkspaceStatus, CodeHostConnection, CodeHostRepository } from "../cloud-types"

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function text(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export function cloudStatusFromWire(status: unknown, step?: unknown, message?: unknown): CloudWorkspaceStatus {
  switch (status) {
    case "provisioning":
    case "acquiring_sandbox":
    case "cloning":
    case "starting_runtime":
    case "waiting_health":
      return { kind: "provisioning", step: text(step) ?? (typeof status === "string" ? status : "provisioning") }
    case "starting":
      return { kind: "starting" }
    case "ready":
    case "running":
    case "active":
      return { kind: "ready" }
    case "stopping":
      return { kind: "stopping" }
    case "error":
    case "failed":
      return { kind: "failed", reason: text(message) ?? "The cloud workspace failed" }
    default:
      return { kind: "stopped" }
  }
}

export function provisionStatus(frame: Record<string, unknown>): CloudWorkspaceStatus {
  const step = frame.step
  if (step === "ready") return { kind: "ready" }
  if (step === "error") return { kind: "failed", reason: text(frame.message) ?? "Provisioning failed" }
  return { kind: "provisioning", step: text(step) ?? "provisioning" }
}

export function cloudWorkspaceFromRow(row: unknown): CloudWorkspace | undefined {
  if (!isRecord(row)) return undefined
  const id = text(row.workspace_id) ?? text(row.workspaceId)
  const owner = text(row.project_id) ?? text(row.projectId)
  if (!id || !owner) return undefined
  const branch = text(row.git_branch) ?? text(row.gitBranch) ?? text(row.branch)
  return {
    id: placementId(id),
    projectId: projectId(owner),
    name: text(row.workspace_name) ?? text(row.workspaceName) ?? text(row.display_name) ?? id,
    ...(branch ? { branch } : {}),
    status: cloudStatusFromWire(row.status, row.step, row.error),
  }
}

export function codeHostConnectionFromRow(row: unknown): CodeHostConnection | undefined {
  if (!isRecord(row)) return undefined
  const id = text(row.id) ?? text(row.connection_id)
  if (!id) return undefined
  const status = row.status === "connected" || row.status === "degraded" || row.status === "broken" ? row.status : "connected"
  const label = text(row.account_label) ?? text(row.accountLabel) ?? text(row.login)
  return { id, providerName: text(row.provider_name) ?? text(row.providerName) ?? text(row.provider) ?? "GitHub", ...(label ? { accountLabel: label } : {}), status }
}

export function codeHostRepositoryFromRow(row: unknown): CodeHostRepository | undefined {
  if (!isRecord(row)) return undefined
  const fullName = text(row.full_name) ?? text(row.fullName)
  return fullName ? { id: text(row.id) ?? fullName, fullName, private: row.private === true } : undefined
}
