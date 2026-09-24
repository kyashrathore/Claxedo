import { createMemo } from "solid-js"
import { useProjectList } from "@/projects"
import { useServer, type PlacementId } from "@/server"
import { useWorkbench } from "@/workbench"
import { useShellRoute } from "./router"

export function useActivePlacement(): () => PlacementId | undefined {
  const server = useServer()
  const workbench = useWorkbench()
  const routing = useShellRoute()
  const projects = useProjectList()
  const focused = createMemo(() => {
    const content = workbench.selectors.focusedContent()
    return content ? workbench.routeOf(content)?.placementId : undefined
  })
  const listed = createMemo(() => {
    const placements = server.placements.list()
    for (const entry of projects.list()) {
      const id = entry.project.id
      const owned = placements.filter((placement) => placement.projectId === id)
      const primary = owned.find((placement) => placement.kind === "folder") ?? owned[0]
      if (primary) return primary.id
    }
    return undefined
  })
  return () => routing.placementId() ?? focused() ?? listed()
}
