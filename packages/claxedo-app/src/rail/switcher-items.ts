import { createMemo, type Accessor } from "solid-js"
import { useProjectList } from "@/projects"
import { useServer, type ProjectId } from "@/server"
import { panePlacementOf } from "@/shell"
import { useSessionStores } from "@/session"
import { useTerminals } from "@/terminal"
import { useWorkbench } from "@/workbench"
import { navigationStatus, terminalNavigationStatus, type NavigationStatus } from "./model"
import { projectSection } from "./project-sections"

export type SwitcherKind = "session" | "terminal" | "other"

export type SwitcherItem = {
  readonly contentId: string
  readonly kind: SwitcherKind
  readonly title: string
  readonly projectLabel: string | undefined
  readonly workspaceLabel: string | undefined
  readonly status: NavigationStatus
}

function kindOf(paneKind: string): SwitcherKind {
  if (paneKind === "session" || paneKind === "draftSession") return "session"
  return paneKind === "terminal" ? "terminal" : "other"
}

function useProjectLabels(): Accessor<ReadonlyMap<ProjectId, string>> {
  const server = useServer()
  const projects = useProjectList()
  return createMemo(() => {
    const placements = server.placements.list()
    const map = new Map<ProjectId, string>()
    for (const entry of projects.list()) {
      const section = projectSection(entry.project, placements)
      if (section.projectId) map.set(section.projectId, section.label)
    }
    return map
  })
}

export function useSwitcherItems(): Accessor<readonly SwitcherItem[]> {
  const workbench = useWorkbench()
  const server = useServer()
  const stores = useSessionStores()
  const terminals = useTerminals()
  const labels = useProjectLabels()
  return createMemo(() =>
    workbench.selectors.aliveContents().flatMap((contentId) => {
      const opened = workbench.content(contentId)
      if (!opened) return []
      const route = workbench.routeOf(contentId)
      const placementId = panePlacementOf(route)
      const placement = placementId ? server.placements.byId(placementId) : undefined
      const row = route?.kind === "session" ? stores.list.view(route.sessionId) : undefined
      const terminal =
        route?.kind === "terminal"
          ? terminals.items(route.placementId).find((item) => item.terminalId === route.terminalId)
          : undefined
      return [
        {
          contentId,
          kind: kindOf(opened.kind.kind),
          title: opened.content?.title() ?? "",
          projectLabel: placement ? labels().get(placement.projectId) : undefined,
          workspaceLabel: placement?.label,
          status: row ? navigationStatus(row, stores.unseenFailures.has(row.ref.sessionId)) : terminal ? terminalNavigationStatus(terminal) : "idle",
        },
      ]
    }),
  )
}
