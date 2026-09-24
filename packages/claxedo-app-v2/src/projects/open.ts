import { useNavigate } from "@solidjs/router"
import { failureMessage } from "@/lib/failure"
import { uuid } from "@/lib/uuid"
import { useServer, type PlacementId } from "@/server"
import { draftSessionPaneKind } from "@/session/view"
import { homePath, sessionPath } from "@/shell"
import { showToast } from "@/ui"
import { useWorkbench } from "@/workbench"
import type { ProjectCreated } from "./add-project"
import { useProjectsText } from "./i18n"
import { projectPath } from "./routes"

export function usePlacementOpener(): (placementId: PlacementId) => void {
  const server = useServer()
  const workbench = useWorkbench()
  const navigate = useNavigate()
  const t = useProjectsText()
  return (placementId) => {
    const placement = server.placements.byId(placementId)
    if (!placement) return void showToast({ title: t("projects.placement.openFailed") })
    workbench.openPane(draftSessionPaneKind, { projectId: placement.projectId, placementId, draftId: uuid() })
    navigate(homePath)
  }
}

export function useCreatedProjectOpener(): (created: ProjectCreated) => void {
  const server = useServer()
  const navigate = useNavigate()
  const t = useProjectsText()
  const report = (error: unknown) => showToast({ title: t("projects.placement.openFailed"), description: failureMessage(error) })
  return (created) => {
    const placementId = created.placementId
    if (!placementId) return navigate(projectPath(created.projectId))
    void server.sessions
      .create({ placementId, ...(created.harnessId ? { harness: created.harnessId } : {}) })
      .then((row) => navigate(sessionPath(row.ref)))
      .catch((error: unknown) => {
        navigate(projectPath(created.projectId))
        report(error)
      })
  }
}
