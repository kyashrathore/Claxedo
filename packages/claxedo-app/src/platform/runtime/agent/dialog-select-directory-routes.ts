export type WorkspaceRuntimeFileResource = "file" | "file/content" | "file/status"

export function claxedoBootstrapUrl(input: { serverUrl: string }) {
  return new URL("/api/claxedo/bootstrap", input.serverUrl)
}

export function workspaceRuntimeFilePath(input: {
  resource: WorkspaceRuntimeFileResource
  scope: string
  workspace?: string
  path?: string
}) {
  const url = new URL(`/${input.resource}`, "http://claxedo.local")
  url.searchParams.set("directory", input.scope)
  if (input.workspace) url.searchParams.set("workspace", input.workspace)
  if (input.path !== undefined) url.searchParams.set("path", input.path)
  return `${url.pathname}${url.search}`
}

export function workspaceRuntimeFindFilePath(input: {
  scope: string
  workspace?: string
  query: string
  dirs?: "true" | "false"
  type?: "file" | "directory"
  limit?: number
}) {
  const url = new URL("/find/file", "http://claxedo.local")
  url.searchParams.set("directory", input.scope)
  if (input.workspace) url.searchParams.set("workspace", input.workspace)
  url.searchParams.set("query", input.query)
  if (input.dirs) url.searchParams.set("dirs", input.dirs)
  if (input.type) url.searchParams.set("type", input.type)
  if (input.limit !== undefined) url.searchParams.set("limit", String(input.limit))
  return `${url.pathname}${url.search}`
}
