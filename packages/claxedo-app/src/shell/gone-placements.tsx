import { createEffect, createMemo, on, untrack, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { useServer, type PlacementId } from "@/server"
import { showToast } from "@/ui"
import { useWorkbench } from "@/workbench"
import { gonePlacementsNotice } from "./gone-placements-notice"
import { shellDictionary } from "./i18n"
import { useShellRoute } from "./router"
import { homePath, panePlacementOf } from "./routes"

export function ForgetGonePlacements(): JSX.Element {
  const server = useServer()
  const workbench = useWorkbench()
  const routing = useShellRoute()
  const t = useTranslator(shellDictionary)
  const answered = createMemo(() => server.placements.openable() !== undefined)
  const forget = (openable: ReadonlySet<PlacementId>) => {
    const gone = (id: PlacementId | undefined) => id !== undefined && !openable.has(id)
    const stale = workbench.layout().contentIds.filter((contentId) => gone(panePlacementOf(workbench.routeOf(contentId))))
    for (const contentId of stale) workbench.closeContent(contentId)
    const routed = gone(routing.placementId())
    if (routed) routing.navigate(homePath, { replace: true })
    const notice = gonePlacementsNotice({ closedTabs: stale.length, routedGone: routed })
    if (notice) showToast({ title: t(notice) })
  }
  createEffect(on(answered, (ready) => {
    const openable = ready ? untrack(server.placements.openable) : undefined
    if (openable) untrack(() => forget(openable))
  }))
  return null
}
