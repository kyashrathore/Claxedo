import { useTranslator } from "@/i18n"
import { failureMessage } from "@/lib/failure"
import { sessionAttention, useServer } from "@/server"
import { useSessionStores, type SessionRowView } from "@/session"
import { showToast, useDialog } from "@/ui"
import { railDictionary } from "../i18n"
import type { SessionRowMenuActions } from "./session-row-menu"
import { RenameSessionDialog } from "./session-dialogs"

export function createSessionActions(): SessionRowMenuActions {
  const t = useTranslator(railDictionary)
  const server = useServer()
  const dialog = useDialog()
  const list = useSessionStores().list
  const report = (title: string) => (error: unknown): void => {
    showToast({ title, description: failureMessage(error) })
  }
  return {
    onRename: (row: SessionRowView) =>
      dialog.show(() => <RenameSessionDialog title={row.title} onSubmit={(title) => server.sessions.rename(row.ref, title)} />),
    onToggleSettled: (row: SessionRowView) => {
      const settled = row.attention && sessionAttention(row.attention, row.reader).settled
      return (settled ? list.returnToActive(row) : list.settle(row)).catch(report(t("rail.settleFailed")))
    },
  }
}
