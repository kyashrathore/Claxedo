import { useNavigate } from "@solidjs/router"
import { failureMessage } from "@/lib/failure"
import { useServer, type PlacementId } from "@/server"
import { draftPath, sessionPath } from "@/shell"
import { showToast } from "@/ui"
import type { ProjectCreated } from "./add-project"
import { useProjectsText } from "./i18n"
import { projectSettingsPath } from "./routes"

export function usePlacementOpener(): (placementId: PlacementId) => void {
  const server = useServer()
  const navigate = useNavigate()
  const t = useProjectsText()
  return (placementId) => {
    if (!server.placements.byId(placementId)) return void showToast({ title: t("projects.placement.openFailed") })
    navigate(draftPath(placementId))
  }
}

export function useCreatedProjectOpener(): (created: ProjectCreated) => void {
  const server = useServer()
  const navigate = useNavigate()
  const t = useProjectsText()
  const report = (error: unknown) => showToast({ title: t("projects.placement.openFailed"), description: failureMessage(error) })
  return (created) => {
    const placementId = created.placementId
    if (!placementId) return navigate(projectSettingsPath(created.projectId))
    void server.sessions
      .create({ placementId, ...(created.harnessId ? { harness: created.harnessId } : {}) })
      .then((row) => navigate(sessionPath(row.ref)))
      .catch((error: unknown) => {
        navigate(projectSettingsPath(created.projectId))
        report(error)
      })
  }
}
