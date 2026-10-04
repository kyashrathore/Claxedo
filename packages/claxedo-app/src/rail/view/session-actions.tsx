import { useTranslator } from "@/i18n"
import { failureMessage } from "@/lib/failure"
import { useServer } from "@/server"
import { useSessionStores, type SessionRowView } from "@/session"
import { showToast, useDialog } from "@/ui"
import { railDictionary } from "../i18n"
import type { SessionRowMenuActions } from "./session-row-menu"
import { RenameSessionDialog } from "./session-dialogs"

export function createSessionActions(): SessionRowMenuActions {
  const t = useTranslator(railDictionary)
  const server = useServer()
  const list = useSessionStores().list
  const dialog = useDialog()
  return {
    onRename: (row: SessionRowView) =>
      dialog.show(() => <RenameSessionDialog title={row.title} onSubmit={(title) => server.sessions.rename(row.ref, title)} />),
    onToggleSettled: (row: SessionRowView) =>
      list.settle(row.ref, !row.settled).catch((error: unknown) => {
        showToast({ title: t("rail.settleFailed"), description: failureMessage(error) })
      }),
  }
}
