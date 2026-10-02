import { useNavigate } from "@solidjs/router"
import { useServer, type Placement, type PlacementId, type ProjectId } from "@/server"
import { draftPath } from "@/shell"
import { showToast } from "@/ui"
import { useProjectsText } from "./i18n"

export function primaryPlacement(placements: readonly Placement[], project: ProjectId): Placement | undefined {
  const own = placements.filter((placement) => placement.projectId === project)
  return own.find((placement) => placement.kind === "folder") ?? own[0]
}

export function usePlacementOpener(): (placementId: PlacementId) => void {
  const server = useServer()
  const navigate = useNavigate()
  const t = useProjectsText()
  return (placementId) => {
    if (!server.placements.byId(placementId)) {
      showToast({ title: t("projects.placement.openFailed") })
      return
    }
    navigate(draftPath(placementId))
  }
}
