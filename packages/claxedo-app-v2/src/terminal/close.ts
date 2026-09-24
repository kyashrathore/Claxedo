import { onCleanup } from "solid-js"
import { useTranslator } from "@/i18n"
import { toAppError } from "@/server"
import { showToast } from "@/ui"
import { useWorkbench } from "@/workbench"
import type { Terminals } from "./context"
import { dictionary } from "./i18n"
import type { TerminalPaneState } from "./model"
import { terminalPaneKind } from "./pane"

export function useEndTerminal(terminals: Terminals): (state: TerminalPaneState) => Promise<void> {
  const t = useTranslator(dictionary)
  return (state) =>
    terminals
      .store(state.placementId)
      .close(state.terminalId)
      .catch((cause: unknown) => {
        const error = toAppError(cause)
        if (error.class === "not_found") return
        console.error("Terminal could not be ended", { terminalId: state.terminalId, error })
        showToast({ title: t("terminal.closeFailed") })
      })
}

export function useEndTerminalOnClose(terminals: Terminals): void {
  const workbench = useWorkbench()
  const end = useEndTerminal(terminals)
  onCleanup(workbench.onClosed(terminalPaneKind, (state) => void end(state)))
}
