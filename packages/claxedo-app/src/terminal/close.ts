import { createEffect, createMemo, on, onCleanup } from "solid-js"
import { useTranslator } from "@/i18n"
import { toAppError } from "@/server"
import { showToast } from "@/ui"
import { useWorkbench } from "@/workbench"
import { terminalContents } from "./contents"
import type { Terminals } from "./context"
import { terminalDictionary } from "./i18n"
import type { TerminalPaneState } from "./model"
import { terminalPaneKind } from "./pane"

export function useEndTerminal(terminals: Terminals): (state: TerminalPaneState) => Promise<void> {
  const t = useTranslator(terminalDictionary)
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

export function useCloseEndedTerminals(terminals: Terminals): void {
  const workbench = useWorkbench()
  const contents = createMemo(() => terminalContents(workbench))
  const placements = createMemo(() => [...new Set(contents().map((content) => content.state.placementId))], [], {
    equals: (previous, next) => previous.join("\n") === next.join("\n"),
  })
  createEffect(
    on(placements, (placementIds) => {
      const releases = placementIds.map((placementId) => terminals.retain(placementId))
      onCleanup(() => releases.forEach((release) => release()))
    }),
  )
  createEffect(() => {
    for (const { contentId, state } of contents()) {
      const store = terminals.store(state.placementId)
      if (store.load().kind === "ready" && !store.row(state.terminalId) && !store.lost(state.terminalId))
        workbench.closeContent(contentId)
    }
  })
}
