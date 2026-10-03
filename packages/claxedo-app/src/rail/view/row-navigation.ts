import { createMemo } from "solid-js"
import { useServer } from "@/server"
import type { SessionRowView } from "@/session"
import { sessionLinkPath, useShellRoute } from "@/shell"
import { terminalPaneKind } from "@/terminal"
import { useWorkbench } from "@/workbench"
import { sessionMarker, type RailRow } from "../model"

export function createRowNavigation() {
  const server = useServer()
  const routing = useShellRoute()
  const workbench = useWorkbench()
  const thisMachine = () => server.capabilities()?.thisMachine?.id
  const shown = createMemo(() => {
    const content = routing.placementId() ? workbench.selectors.shownContent() : null
    return content ? workbench.routeOf(content) : undefined
  })
  return {
    shown,
    activeSessionId: () => {
      const pane = shown()
      return pane?.kind === "session" ? pane.sessionId : undefined
    },
    open: (row: SessionRowView) => routing.navigate(sessionLinkPath(row.ref, server.placements.byId(row.ref.placementId), thisMachine())),
    markerOf: (row: SessionRowView) => sessionMarker(server.placements.byId(row.ref.placementId), thisMachine()),
    prepareDrag: (row: RailRow) =>
      row.kind === "session"
        ? workbench.openRoute({ kind: "session", ...row.session.ref }, false)
        : workbench.open(terminalPaneKind, { placementId: row.terminal.placementId, terminalId: row.terminal.terminalId }, false),
  }
}

export function moveRowFocus(event: KeyboardEvent): void {
  const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0
  const target = event.target
  if (step === 0 || !(target instanceof HTMLElement) || target.dataset.slot !== "navigation-row-activate" || !(event.currentTarget instanceof HTMLElement)) return
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-slot="navigation-row-activate"]')]
  const next = rows[rows.indexOf(target) + step]
  if (!next) return
  event.preventDefault()
  next.focus()
}
