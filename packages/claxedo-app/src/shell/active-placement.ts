import { createMemo } from "solid-js"
import { useProjectList } from "@/projects"
import { useServer, type PlacementId, type ProjectId } from "@/server"
import { useWorkbench } from "@/workbench"
import { useShellRoute } from "./router"
import { panePlacementOf } from "./routes"

export function useActivePlacement(): () => PlacementId | undefined {
  const server = useServer()
  const workbench = useWorkbench()
  const routing = useShellRoute()
  const projects = useProjectList()
  const focused = createMemo(() => {
    const content = workbench.selectors.focusedContent()
    return content ? panePlacementOf(workbench.routeOf(content)) : undefined
  })
  const listed = createMemo(() => {
    const placements = server.placements.list()
    const primaryOf = (id: ProjectId) => {
      const owned = placements.filter((placement) => placement.projectId === id)
      return (owned.find((placement) => placement.kind === "folder") ?? owned[0])?.id
    }
    const entries = projects.list()
    const available = entries.filter((entry) => entry.project.available)
    for (const entry of [...available, ...entries]) {
      const primary = primaryOf(entry.project.id)
      if (primary) return primary
    }
    return undefined
  })
  return () => routing.placementId() ?? focused() ?? listed()
}
