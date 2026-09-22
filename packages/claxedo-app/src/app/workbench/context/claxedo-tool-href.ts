import { sessionRoute, tasksRoute, workspacePageRoute, workspaceRoute } from "@/platform/identity/route"
import { opaqueWorkspaceRouteId } from "@/platform/identity/workspace-route"
import { recordOrEmpty } from "@/lib/record"

function toolResourceRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { return toolResourceRecord(JSON.parse(value)) } catch { return {} }
  }
  return recordOrEmpty(value)
}

function nonblankToolResourceString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined
}

/** Translate MCP resource identities into the same routes as the workbench. */
export function claxedoToolHref(
  tool: string,
  input: Record<string, unknown>,
  output: string | undefined,
  scope: { workspaceId?: string; sessionId?: string; workspaceForDirectory?: (directory: string) => string | undefined },
): string | undefined {
  const args = input.server && input.tool ? toolResourceRecord(input.arguments) : input
  const result = toolResourceRecord(output)
  const targetDirectory = nonblankToolResourceString(args.directory) ?? (tool.startsWith("documents_") ? nonblankToolResourceString(args.project) : undefined)
  const workspaceId = opaqueWorkspaceRouteId(nonblankToolResourceString(args.workspace) ?? (targetDirectory
    ? scope.workspaceForDirectory?.(targetDirectory)
    : scope.workspaceId))
  const workspace = workspaceId ? workspaceRoute(workspaceId) : undefined
  const session = nonblankToolResourceString(args.session) ?? nonblankToolResourceString(args.sessionId) ?? nonblankToolResourceString(result.sessionId)
    ?? nonblankToolResourceString(result.session) ?? nonblankToolResourceString(toolResourceRecord(result.session).id)
    ?? (tool === "session_create" ? nonblankToolResourceString(result.id) : undefined)
  if (tool.startsWith("task_")) {
    const task = nonblankToolResourceString(args.task) ?? nonblankToolResourceString(toolResourceRecord(result.task).id)
    return tasksRoute(task ? { kind: "task", taskId: task } : undefined)
  }
  if (tool === "process" || tool.startsWith("process_") || tool === "processes") {
    if (!workspace) return undefined
    const process = nonblankToolResourceString(args.process)
    return `${workspace}?panel=processes${process ? `&process=${encodeURIComponent(process)}` : ""}`
  }
  if (tool.startsWith("documents_")) {
    if (!workspaceId) return undefined
    // A display name is not an id: documents_open resolves it in its result.
    const document = nonblankToolResourceString(result.document)
    return workspacePageRoute(workspaceId, document ?? "__index__")
  }
  if (tool === "session_changes") return session ? `${sessionRoute(session)}?panel=changes` : undefined
  if (tool === "session_delete") return workspace ?? "/"
  if (tool.includes("subagent")) {
    const target = session ?? scope.sessionId
    return target ? sessionRoute(target) : undefined
  }
  if (session) return sessionRoute(session)
  if (tool === "workspaces_list" || tool === "sessions_board" || tool === "wait_for_attention") return "/"
  if (tool === "sessions_list") {
    return nonblankToolResourceString(args.workspace) ? workspace : "/"
  }
  if (tool.startsWith("workspace_")) return workspace
  if (tool.startsWith("question_") || tool === "permission_reply") {
    return scope.sessionId ? sessionRoute(scope.sessionId) : workspace
  }
  return workspace
}
