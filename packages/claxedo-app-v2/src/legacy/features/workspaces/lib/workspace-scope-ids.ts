import type { Pane } from "../../../app/workbench/workbench/index"
import type { ContentMeta } from "../../../app/workbench/state/index"
import { realDirectory } from "@/features/workspaces/app-ports"
import { sessionPaneWorkspaceKey, type SessionWorkspaceRuntimeInput } from "@/platform/runtime/session-workspace"

export function openWorkspaceScopeIds(input: {
  /** Canonical route/workspace identity; stable while sessions change. */
  canonicalRouteId?: string
  activeDirectory?: string
  visiblePanes: readonly Pane[]
  meta: (id: string) => ContentMeta | undefined
  projects?: SessionWorkspaceRuntimeInput["projects"]
}) {
  return [
    input.canonicalRouteId,
    input.activeDirectory,
    ...input.visiblePanes.flatMap((pane) => {
      if (!pane.contentId) return []
      const meta = input.meta(pane.contentId)
      if (!meta) return []
      const sessionRef = meta.content?.type === "session" ? meta.content.sessionRef : undefined
      return [
        realDirectory(meta.directory),
        sessionPaneWorkspaceKey({
          directory: meta.directory ?? "",
          sessionRef,
          projects: input.projects,
        }),
      ]
    }),
  ].filter((scopeId, index, all): scopeId is string =>
    !!scopeId && all.indexOf(scopeId) === index
  )
}
