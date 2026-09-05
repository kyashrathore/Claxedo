import { workspaceRuntimeRoute } from "@claxedo/workspace-runtime/routes"

/** FileRoutes is mounted at both / and /api/wr by mountWorkspaceFiles. */
export function workspaceFileResourcePath(pathName: string): string | undefined {
  const route = workspaceRuntimeRoute(pathName)
  if (route?.family === "file") return `/file${pathName.slice(route.path.length)}`
  if (route?.family === "fileSearch") return `/find/file${pathName.slice(route.path.length)}`
  if (pathName === "/file" || pathName.startsWith("/file/") || pathName === "/find/file") return pathName
}
