export function claxedoRequestScope(
  origin: string,
  requestPath: string,
  scope: Readonly<{ type: "owner" }> | Readonly<{ type: "workspace"; directory: string; workspaceId?: string }>,
) {
  if (scope.type === "owner") return { url: `${origin}${requestPath}`, headers: {} }
  const query = new URLSearchParams({ directory: scope.directory })
  if (scope.workspaceId) query.set("workspaceId", scope.workspaceId)
  return {
    url: `${origin}${requestPath}${requestPath.includes("?") ? "&" : "?"}${query}`,
    headers: {
      "x-opencode-directory": scope.directory,
      ...(scope.workspaceId ? { "x-workspace-id": scope.workspaceId } : {}),
    },
  }
}
