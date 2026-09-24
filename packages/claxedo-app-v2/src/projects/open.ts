import { useNavigate } from "@solidjs/router"
import { failureMessage } from "@/lib/failure"
import { useServer, type PlacementId } from "@/server"
import { sessionPath } from "@/shell"
import { showToast } from "@/ui"
import type { ProjectCreated } from "./add-project"
import { useProjectsText } from "./i18n"
import { projectPath } from "./routes"

export type PlacementOpener = {
  readonly openPlacement: (placementId: PlacementId) => void
  readonly openCreated: (created: ProjectCreated) => void
}

export function usePlacementOpener(): PlacementOpener {
  const server = useServer()
  const navigate = useNavigate()
  const t = useProjectsText()
  const startSession = async (placementId: PlacementId, harnessId?: string) => {
    const row = await server.sessions.create({ placementId, ...(harnessId ? { harness: harnessId } : {}) })
    navigate(sessionPath(row.ref))
  }
  const report = (error: unknown) => showToast({ title: t("projects.placement.openFailed"), description: failureMessage(error) })
  return {
    openPlacement: (placementId) => void startSession(placementId).catch(report),
    openCreated: (created) => {
      if (!created.placementId) return navigate(projectPath(created.projectId))
      void startSession(created.placementId, created.harnessId).catch((error: unknown) => {
        navigate(projectPath(created.projectId))
        report(error)
      })
    },
  }
}
