import { createMemo, For, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { useProjectList } from "@/projects"
import { useServer } from "@/server"
import { useSessionStores } from "@/session"
import { draftPath, panePlacementOf, useShellRoute } from "@/shell"
import { useTerminals } from "@/terminal"
import { railDictionary } from "../i18n"
import { sessionIdsByProject } from "../model"
import { projectSection, type ProjectSection } from "../project-sections"
import { ProjectBlock } from "./project-block"
import { createRowNavigation } from "./row-navigation"
import { createSessionActions } from "./session-actions"

export function ProjectTree(): JSX.Element {
  const t = useTranslator(railDictionary)
  const projects = useProjectList()
  const server = useServer()
  const stores = useSessionStores()
  const routing = useShellRoute()
  const actions = createSessionActions()
  const terminals = useTerminals()
  const navigation = createRowNavigation()
  const sections = createMemo(() => projects.list().map((entry) => projectSection(entry.project, server.placements.list())))
  const sectionByKey = createMemo(() => new Map(sections().map((section) => [section.key, section])))
  const grouped = createMemo(() => sessionIdsByProject(stores.list.order().filter((ref) => !server.sharedSessions.find(ref))))
  const sessionIdsOf = (section: ProjectSection) => (section.projectId ? grouped().get(section.projectId) : undefined) ?? []
  const activeProjectId = createMemo(() => {
    const placement = panePlacementOf(navigation.shown())
    return placement ? server.placements.byId(placement)?.projectId : undefined
  })
  const activeTerminalId = () => {
    const pane = navigation.shown()
    return pane?.kind === "terminal" ? pane.terminalId : undefined
  }
  const select = (section: ProjectSection) => {
    if (section.placementId) routing.navigate(draftPath(section.placementId))
  }
  return (
    <div class="flex-1 flex flex-col py-1.5 gap-0.5">
      <Show when={sections().length > 0} fallback={<div class="flex px-4 py-8 text-compact text-text-weak">{t("rail.noMatches")}</div>}>
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
                    activeSessionId={navigation.activeSessionId()}
                    activeTerminalId={activeTerminalId()}
                    list={stores.list}
                    onSelect={select}
                    onNewTerminal={(section) => section.placementId && terminals.startNew(section.placementId)}
                    onActivate={navigation.open}
                    markerOf={navigation.markerOf}
                    prepareDrag={navigation.prepareDrag}
                    onRename={actions.onRename}
                    onToggleSettled={actions.onToggleSettled}
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
