import { createMemo, For, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { useClock } from "@/lib/clock"
import { useProjectList } from "@/projects"
import { useServer } from "@/server"
import { useSessionStores, type SessionRowView } from "@/session"
import { draftPath, sessionPath, useShellRoute } from "@/shell"
import { useTerminals } from "@/terminal"
import { dictionary } from "../i18n"
import { rowsByProject, siblingAfterArchive } from "../model"
import { projectSection, type ProjectSection } from "../project-sections"
import { ProjectBlock } from "./project-block"
import { createSessionActions } from "./session-actions"

export function ProjectTree(): JSX.Element {
  const t = useTranslator(dictionary)
  const projects = useProjectList()
  const server = useServer()
  const stores = useSessionStores()
  const routing = useShellRoute()
  const actions = createSessionActions()
  const terminals = useTerminals()
  const sections = createMemo(() => projects.list().map((entry) => projectSection(entry.project, server.placements.list())))
  const sectionByKey = createMemo(() => new Map(sections().map((section) => [section.key, section])))
  const grouped = createMemo(() => rowsByProject(stores.list.rows()))
  const rowsOf = (section: ProjectSection) => (section.projectId ? grouped().get(section.projectId) : undefined) ?? []
  const activeProjectId = createMemo(() => {
    const placement = routing.placementId()
    return placement ? server.placements.byId(placement)?.projectId : undefined
  })
  const activeSessionId = () => {
    const route = routing.route()
    return route.kind === "session" ? route.sessionId : undefined
  }
  const activeTerminalId = () => {
    const route = routing.route()
    return route.kind === "terminal" ? route.terminalId : undefined
  }
  const now = useClock()
  const select = (section: ProjectSection) => {
    if (section.placementId) routing.navigate(draftPath(section.placementId))
  }
  const archive = async (section: ProjectSection, row: SessionRowView) => {
    if (activeSessionId() === row.ref.sessionId) {
      const next = siblingAfterArchive(rowsOf(section), row)
      if (next) routing.navigate(sessionPath(next.ref))
      else select(section)
    }
    await actions.onArchive(row)
  }
  return (
    <div class="flex-1 flex flex-col py-1.5 gap-0.5">
      <Show when={sections().length > 0} fallback={<div class="flex px-4 py-8 text-compact text-text-weak">{t("rail.noMatches")}</div>}>
        <div data-slot="rail-section-label" class="px-4 pt-1 pb-1 text-xs font-medium uppercase tracking-normal text-text-weaker">
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
                    rows={rowsOf(current())}
                    active={!!current().projectId && current().projectId === activeProjectId()}
                    activeSessionId={activeSessionId()}
                    activeTerminalId={activeTerminalId()}
                    now={now}
                    list={stores.list}
                    onSelect={select}
                    onNewTerminal={(section) => section.placementId && terminals.startNew(section.placementId)}
                    onActivate={(row) => routing.navigate(sessionPath(row.ref))}
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
