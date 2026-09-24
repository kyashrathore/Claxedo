import { placementId, projectId } from "../ids"
import type { CloudWorkspace, CloudWorkspaceStatus, CodeHostConnection, CodeHostRepository } from "../cloud-types"

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function text(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function cloudStatusFromWire(status: unknown, step?: unknown, message?: unknown): CloudWorkspaceStatus {
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
    case "stopped":
      return { kind: "stopped" }
    case "error":
    case "failed":
      return { kind: "failed", reason: text(message) ?? "The cloud workspace failed" }
    default:
      return { kind: "failed", reason: `The cloud workspace reports an unknown status: ${String(status)}` }
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

const CODE_HOST_CAPABILITY = "code-host"

function codeHostNames(integrations: unknown): ReadonlyMap<string, string> {
  const rows = Array.isArray(integrations) ? integrations : []
  return new Map(rows.flatMap((row) => {
    if (!isRecord(row) || typeof row.id !== "string") return []
    const capabilities = Array.isArray(row.capabilities) ? row.capabilities : []
    return capabilities.includes(CODE_HOST_CAPABILITY) ? [[row.id, text(row.name) ?? row.id] as const] : []
  }))
}

export function codeHostConnectionsFromWire(body: unknown): CodeHostConnection[] {
  const root = isRecord(body) ? body : {}
  const names = codeHostNames(root.integrations)
  const connections = Array.isArray(root.connections) ? root.connections : []
  return connections.flatMap((row) => {
    if (!isRecord(row)) return []
    const id = text(row.id)
    const providerName = names.get(text(row.integrationId) ?? "")
    if (!id || !providerName) return []
    const accountLabel = text(row.accountLabel)
    const status = row.status === "connected" || row.status === "degraded" ? row.status : "broken"
    return [{ id, providerName, ...(accountLabel ? { accountLabel } : {}), status }]
  })
}

export function codeHostRepositoryFromRow(row: unknown): CodeHostRepository | undefined {
  if (!isRecord(row)) return undefined
  const id = text(row.id)
  const fullName = text(row.fullName)
  return id && fullName ? { id, fullName, private: row.private === true } : undefined
}
