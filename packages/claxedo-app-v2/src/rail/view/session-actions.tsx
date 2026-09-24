import { useTranslator } from "@/i18n"
import { failureMessage } from "@/lib/failure"
import { useServer } from "@/server"
import type { SessionRowView } from "@/session"
import { showToast, useDialog } from "@/ui"
import { dictionary } from "../i18n"
import type { SessionRowMenuActions } from "./session-row-menu"
import { DeleteSessionDialog, RenameSessionDialog } from "./session-dialogs"

export function createSessionActions(): SessionRowMenuActions {
  const t = useTranslator(dictionary)
  const server = useServer()
  const dialog = useDialog()
  const report = (title: string) => (error: unknown): void => {
    showToast({ title, description: failureMessage(error) })
  }
  return {
    onRename: (row: SessionRowView) =>
      dialog.show(() => <RenameSessionDialog title={row.title} onSubmit={(title) => server.sessions.rename(row.ref, title)} />),
    onArchive: (row: SessionRowView) => server.sessions.archive(row.ref, true).catch(report(t("rail.archiveFailed"))),
    onDelete: (row: SessionRowView) =>
      dialog.show(() => <DeleteSessionDialog title={row.title} onConfirm={() => server.sessions.remove(row.ref)} />),
  }
}
