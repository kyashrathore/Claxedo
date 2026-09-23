import { createDiffRoutes } from "../../../../workspace-runtime/src/routes/diff"
import { withWorkspaceTarget } from "../../../../workspace-runtime/src/target"

const emptyDiffRoutes = createDiffRoutes({
  git: async () => ({ stdout: "" }),
})

export type DrivenRuntimeDiffResponse = {
  status: number
  body: unknown
}

/**
 * Drive the real workspace-runtime diff router against an empty Git backend.
 * The target wrapper reproduces the runtime's pinned workspace context, which
 * also lets relay requests omit the local-only `directory` query parameter.
 */
export async function driveEmptyRuntimeDiffRoute(requestUrl: string): Promise<DrivenRuntimeDiffResponse> {
  const incoming = new URL(requestUrl)
  const marker = "/api/wr/diff"
  const markerIndex = incoming.pathname.lastIndexOf(marker)
  if (markerIndex < 0) throw new Error(`Not a workspace-runtime diff URL: ${requestUrl}`)
  const routePath = incoming.pathname.slice(markerIndex + marker.length) || "/"
  const directory = incoming.searchParams.get("directory") || "/mock-runtime-workspace"
  const driven = new URL(routePath, "http://mock-runtime")
  driven.search = incoming.search

  const response = await withWorkspaceTarget(
    { workspaceId: "mock-runtime", directory },
    () => emptyDiffRoutes.request(driven),
  )
  return {
    status: response.status,
    body: await response.json(),
  }
}
