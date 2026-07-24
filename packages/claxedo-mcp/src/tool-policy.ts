export type ClaxedoMcpMode = "full" | "read-only"

const truthy = (value: string | undefined) => {
  const normalized = value?.trim().toLowerCase()
  return normalized === "1" || normalized === "true" || normalized === "yes"
}

export function claxedoMcpMode(env: Record<string, string | undefined> = process.env): ClaxedoMcpMode {
  if (truthy(env.CLAXEDO_MCP_READ_ONLY)) return "read-only"
  if (env.CLAXEDO_MCP_MODE?.trim().toLowerCase() === "read-only") return "read-only"
  return "full"
}

export function claxedoMcpReadOnly(env: Record<string, string | undefined> = process.env) {
  return claxedoMcpMode(env) === "read-only"
}

export type CloudWorkspaceLifecycleAction = "stop" | "restore" | "replace" | "cleanup" | "destroy"

const APPROVAL_REQUIRED = new Set<CloudWorkspaceLifecycleAction>(["restore", "replace", "cleanup", "destroy"])

export function cloudWorkspaceLifecycleApprovalRequired(action: CloudWorkspaceLifecycleAction) {
  return APPROVAL_REQUIRED.has(action)
}

export function assertCloudWorkspaceLifecycleApproval(action: CloudWorkspaceLifecycleAction, approved: boolean | undefined) {
  if (!cloudWorkspaceLifecycleApprovalRequired(action) || approved === true) return
  throw new Error(`Explicit approval is required before cloud workspace ${action}`)
}
