import { createMemo } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useServer, type PlacementId } from "@/server"
import { useSessionStores, type SessionRowView } from "@/session"
import { sessionLinkPath, useShellRoute } from "@/shell"
import { terminalPaneKind } from "@/terminal"
import { useWorkbench } from "@/workbench"
import type { RailRow } from "../model"
import { sessionMarker } from "../session-marker"

export function createRowNavigation() {
  const server = useServer()
  const routing = useShellRoute()
  const stores = useSessionStores()
  const workbench = useWorkbench()
  const machines = useQuery(() => server.queries.machines.list())
  const shown = createMemo(() => {
    const content = routing.placementId() ? workbench.selectors.shownContent() : null
    return content ? workbench.routeOf(content) : undefined
  })
  const activeSessionId = () => {
    const pane = shown()
    return pane?.kind === "session" ? pane.sessionId : undefined
  }
  return {
    shown,
    activeSessionId,
    press: (row: SessionRowView) => {
      if (row.ref.sessionId !== activeSessionId()) stores.open(row.ref)
    },
    open: (row: SessionRowView) => routing.navigate(sessionLinkPath(row.ref, server.placements.byId(row.ref.placementId))),
    markerOf: (placementId: PlacementId) => sessionMarker(server.placements.byId(placementId), machines.data ?? []),
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
