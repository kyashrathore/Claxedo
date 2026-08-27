import type { ActionProps } from "../../../app/workbench/actions/shared"
import { surfaceRoute } from "@/features/documents/app-ports"

export type PageActionProps = Pick<ActionProps, "activeDirectory" | "navigate" | "projects" | "workspaceRouteId"> & {
  state: {
    layout: Pick<ActionProps["state"]["layout"], "openPagesIndex">
  }
}

export function createPageActions(
  props: PageActionProps,
  navigate: (path: string, reason: string, details?: Record<string, unknown>) => void = (path) => props.navigate(path),
) {
  const handleNewPage = () => {

    const current = typeof props.activeDirectory === "function" ? props.activeDirectory() : undefined
    const first = typeof props.projects === "function" ? props.projects()[0]?.worktree : undefined
    const dir = current || first

    if (dir) {
      const workspaceId = props.workspaceRouteId(dir)
      if (!workspaceId) return
      // Open only after the route identity is known; this surface immediately
      // becomes the source of the browser URL.
      props.state.layout.openPagesIndex(dir)
      const route = surfaceRoute(workspaceId, { type: "pages-index" })
      if (route) navigate(route, "new-page", { workspaceDir: dir })
      return
    }

    props.state.layout.openPagesIndex()
  }

  return {
    handleNewPage,
  }
}
