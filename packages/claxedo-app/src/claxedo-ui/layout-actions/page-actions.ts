import type { ActionProps } from "./shared"
import { capture as phCapture } from "../../utils/analytics"
import { surfaceRoute } from "../state/surface-route"

export type PageActionProps = Pick<ActionProps, "activeWorkspaceId" | "navigate" | "projects"> & {
  state: {
    layout: Pick<ActionProps["state"]["layout"], "openPagesIndex">
  }
}

export function createPageActions(props: PageActionProps) {
  const handleNewPage = () => {
    phCapture("page_created")

    const current = typeof props.activeWorkspaceId === "function" ? props.activeWorkspaceId() : undefined
    const first = typeof props.projects === "function" ? props.projects()[0]?.worktree : undefined
    const dir = current || first

    // Open the pages-index content. The orchestration layer focuses by default.
    props.state.layout.openPagesIndex(dir)

    if (dir && typeof props.navigate === "function") {
      const route = surfaceRoute(dir, { type: "pages-index" })
      if (route) props.navigate(route)
    }
  }

  return {
    handleNewPage,
  }
}
