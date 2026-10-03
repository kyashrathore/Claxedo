import { createMemo, For, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { useProjectList } from "@/projects"
import { useServer } from "@/server"
import { useSessionStores, type SessionRowView } from "@/session"
import { draftPath, panePlacementOf, sessionLinkPath, useShellRoute } from "@/shell"
import { terminalPaneKind, useTerminals } from "@/terminal"
import { useWorkbench } from "@/workbench"
import { railDictionary } from "../i18n"
import { sessionIdsByProject, sessionMarker, siblingAfterArchive, type RailRow } from "../model"
import { projectSection, type ProjectSection } from "../project-sections"
import { ProjectBlock } from "./project-block"
import { createSessionActions } from "./session-actions"

export function ProjectTree(): JSX.Element {
  const t = useTranslator(railDictionary)
  const projects = useProjectList()
  const server = useServer()
  const stores = useSessionStores()
  const routing = useShellRoute()
  const actions = createSessionActions()
  const terminals = useTerminals()
  const sections = createMemo(() => projects.list().map((entry) => projectSection(entry.project, server.placements.list())))
  const sectionByKey = createMemo(() => new Map(sections().map((section) => [section.key, section])))
  const grouped = createMemo(() => sessionIdsByProject(stores.list.order().filter((ref) => !server.sharedSessions.find(ref))))
  const sessionIdsOf = (section: ProjectSection) => (section.projectId ? grouped().get(section.projectId) : undefined) ?? []
  const workbench = useWorkbench()
  const shown = createMemo(() => {
    const content = routing.placementId() ? workbench.selectors.shownContent() : null
    return content ? workbench.routeOf(content) : undefined
  })
  const activeProjectId = createMemo(() => {
    const placement = panePlacementOf(shown())
    return placement ? server.placements.byId(placement)?.projectId : undefined
  })
  const activeSessionId = () => {
    const pane = shown()
    return pane?.kind === "session" ? pane.sessionId : undefined
  }
  const activeTerminalId = () => {
    const pane = shown()
    return pane?.kind === "terminal" ? pane.terminalId : undefined
  }
  const prepareDrag = (row: RailRow) =>
    row.kind === "session"
      ? workbench.openRoute({ kind: "session", ...row.session.ref }, false)
      : workbench.open(terminalPaneKind, { placementId: row.terminal.placementId, terminalId: row.terminal.terminalId }, false)
  const markerOf = (row: SessionRowView) => sessionMarker(server.placements.byId(row.ref.placementId), server.capabilities()?.thisMachine?.id)
  const openSession = (row: SessionRowView) =>
    routing.navigate(sessionLinkPath(row.ref, server.placements.byId(row.ref.placementId), server.capabilities()?.thisMachine?.id))
  const select = (section: ProjectSection) => {
    if (section.placementId) routing.navigate(draftPath(section.placementId))
  }
  const archive = async (section: ProjectSection, row: SessionRowView) => {
    const route = routing.route()
    if (route.kind === "session" && route.sessionId === row.ref.sessionId) {
      const nextId = siblingAfterArchive(sessionIdsOf(section), row.ref.sessionId)
      const next = nextId ? stores.list.view(nextId) : undefined
      if (next) openSession(next)
      else select(section)
    }
    await actions.onArchive(row)
  }
  return (
    <div class="flex-1 flex flex-col py-1.5 gap-0.5">
      <Show when={sections().length > 0} fallback={<div class="flex px-4 py-8 text-compact text-text-weak">{t("rail.noMatches")}</div>}>
        <div class="sidebar-section-label px-4 pt-1 pb-1">
          {t("rail.projects")}
        </div>
        <For each={sections().map((section) => section.key)}>
          {(key) => {
            const section = () => sectionByKey().get(key)
            return (
              <Show when={section()}>
                {(current) => (
                  <ProjectBlock
                    section={current()}
                    sessionIds={sessionIdsOf(current())}
                    active={!!current().projectId && current().projectId === activeProjectId()}
                    activeSessionId={activeSessionId()}
                    activeTerminalId={activeTerminalId()}
                    list={stores.list}
                    onSelect={select}
                    onNewTerminal={(section) => section.placementId && terminals.startNew(section.placementId)}
                    onActivate={openSession}
                    markerOf={markerOf}
                    prepareDrag={prepareDrag}
                    onRename={actions.onRename}
                    onArchive={(row) => archive(current(), row)}
                    onDelete={actions.onDelete}
                  />
                )}
              </Show>
            )
          }}
        </For>
      </Show>
    </div>
  )
}
