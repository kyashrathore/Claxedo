import { useTranslator } from "@/i18n"
import { failureMessage } from "@/lib/failure"
import { uuid } from "@/lib/uuid"
import { useServer, type PlacementId } from "@/server"
import type { SessionRowView } from "@/session"
import { draftSessionPaneKind } from "@/session/view"
import { showToast, useDialog } from "@/ui"
import { useWorkbench } from "@/workbench"
import { dictionary } from "../i18n"
import { DeleteSessionDialog, RenameSessionDialog } from "./session-dialogs"

export type SessionActions = {
  readonly startDraft: (placementId: PlacementId) => void
  readonly rename: (row: SessionRowView) => void
  readonly archive: (row: SessionRowView) => void
  readonly remove: (row: SessionRowView) => void
}

export function createSessionActions(): SessionActions {
  const t = useTranslator(dictionary)
  const server = useServer()
  const workbench = useWorkbench()
  const dialog = useDialog()
  const report = (title: string) => (error: unknown) => showToast({ title, description: failureMessage(error) })
  return {
    startDraft: (placementId) => {
      const placement = server.placements.byId(placementId)
      if (!placement) {
        showToast({ title: t("rail.createFailed") })
        return
      }
      workbench.openPane(draftSessionPaneKind, { projectId: placement.projectId, placementId, draftId: uuid() })
    },
    rename: (row) => dialog.show(() => <RenameSessionDialog title={row.title} onSubmit={(title) => server.sessions.rename(row.ref, title)} />),
    archive: (row) => {
      server.sessions.archive(row.ref, true).catch(report(t("rail.archiveFailed")))
    },
    remove: (row) => dialog.show(() => <DeleteSessionDialog title={row.title} onConfirm={() => server.sessions.remove(row.ref)} />),
  }
}
