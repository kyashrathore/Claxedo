import { createMemo, type Accessor } from "solid-js"
import { useProjectList } from "@/projects"
import { useServer, type ProjectId } from "@/server"
import { useSessionStores } from "@/session"
import { useWorkbench } from "@/workbench"
import { navigationStatus, type NavigationStatus } from "./model"
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

export function useSwitcherItems(): Accessor<readonly SwitcherItem[]> {
  const workbench = useWorkbench()
  const server = useServer()
  const stores = useSessionStores()
  const projects = useProjectList()
  const labels = createMemo(() => {
    const placements = server.placements.list()
    const map = new Map<ProjectId, string>()
    for (const project of projects.list()) {
      const section = projectSection(project, placements)
      if (section.projectId) map.set(section.projectId, section.label)
    }
    return map
  })
  return createMemo(() =>
    workbench.selectors.aliveContents().flatMap((contentId) => {
      const opened = workbench.content(contentId)
      if (!opened) return []
      const route = workbench.routeOf(contentId)
      const placement = route ? server.placements.byId(route.placementId) : undefined
      const row = route?.kind === "session" ? stores.list.rows().find((candidate) => candidate.ref.sessionId === route.sessionId) : undefined
      return [
        {
          contentId,
          kind: kindOf(opened.kind.kind),
          title: opened.kind.title(opened.state as never),
          projectLabel: placement ? labels().get(placement.projectId) : undefined,
          workspaceLabel: placement?.label,
          status: row ? navigationStatus(row) : "idle",
        },
      ]
    }),
  )
}
