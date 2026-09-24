import { useTranslator } from "@/i18n"
import { failureMessage } from "@/lib/failure"
import { useServer, type PlacementId } from "@/server"
import { useSessionStores, type SessionRowView } from "@/session"
import { sessionPath, useShellRoute } from "@/shell"
import { showToast, useDialog } from "@/ui"
import { dictionary } from "../i18n"
import { DeleteSessionDialog, RenameSessionDialog } from "./session-dialogs"

export type SessionActions = {
  readonly create: (placementId: PlacementId) => void
  readonly rename: (row: SessionRowView) => void
  readonly archive: (row: SessionRowView) => void
  readonly remove: (row: SessionRowView) => void
}

export function createSessionActions(): SessionActions {
  const t = useTranslator(dictionary)
  const server = useServer()
  const stores = useSessionStores()
  const dialog = useDialog()
  const routing = useShellRoute()
  const report = (title: string) => (error: unknown) => showToast({ title, description: failureMessage(error) })
  return {
    create: (placementId) => {
      stores.list
        .create({ placementId })
        .then((ref) => routing.navigate(sessionPath(ref)))
        .catch(report(t("rail.createFailed")))
    },
    rename: (row) => dialog.show(() => <RenameSessionDialog title={row.title} onSubmit={(title) => server.sessions.rename(row.ref, title)} />),
    archive: (row) => {
      server.sessions.archive(row.ref, true).catch(report(t("rail.archiveFailed")))
    },
    remove: (row) => dialog.show(() => <DeleteSessionDialog title={row.title} onConfirm={() => server.sessions.remove(row.ref)} />),
  }
}
