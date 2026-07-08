import type { Pane } from "./layout"
import { realDirectory, type ContentMeta } from "./state"
import { sessionPaneWorkspaceKey, type SessionWorkspaceRuntimeInput } from "../shell/workspace/session-workspace-key"

export function openWorkspaceScopeIds(input: {
  activeWorkspaceId?: string
  visiblePanes: readonly Pane[]
  meta: (id: string) => ContentMeta | undefined
  projects?: SessionWorkspaceRuntimeInput["projects"]
}) {
  return [
    input.activeWorkspaceId,
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
  ].filter((workspaceId, index, all): workspaceId is string =>
    !!workspaceId && all.indexOf(workspaceId) === index
  )
}
