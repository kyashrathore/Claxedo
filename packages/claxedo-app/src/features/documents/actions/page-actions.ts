import type { ActionProps } from "../../../app/workbench/actions/shared"
import { capture as phCapture } from "@/platform/telemetry/analytics"
import { surfaceRoute } from "@/features/documents/app-ports"

export type PageActionProps = Pick<ActionProps, "activeDirectory" | "navigate" | "projects"> & {
  state: {
    layout: Pick<ActionProps["state"]["layout"], "openPagesIndex">
  }
}

export function createPageActions(props: PageActionProps) {
  const handleNewPage = () => {
    phCapture("page_created")

    const current = typeof props.activeDirectory === "function" ? props.activeDirectory() : undefined
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
