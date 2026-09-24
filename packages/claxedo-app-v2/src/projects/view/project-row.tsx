import { createSignal, Show, type Component } from "solid-js"
import type { Project } from "@/server"
import { projectsText } from "../i18n"

export const ProjectRow: Component<{
  project: Project
  active: boolean
  onOpen: (project: Project) => void
  onRename: (project: Project) => void
  onRemove: (project: Project) => void
}> = (props) => {
  const [menu, setMenu] = createSignal(false)
  return (
    <li class="flex flex-col" data-project-id={props.project.id}>
      <div class="projects-row" aria-current={props.active ? "page" : undefined}>
        <button type="button" class="min-h-11 min-w-0 flex-1 truncate text-left text-sm" onClick={() => props.onOpen(props.project)}>
          {props.project.name}
        </button>
        <button
          type="button"
          class="min-h-11 min-w-11 shrink-0 rounded-md text-sm"
          aria-label={projectsText("projects.actions")}
          aria-expanded={menu()}
          onClick={() => setMenu(!menu())}
        >
          ⋯
        </button>
      </div>
      <Show when={menu()}>
        <div class="flex flex-wrap gap-1 px-2 pb-2" role="group" aria-label={projectsText("projects.actions")}>
          <button type="button" class="min-h-11 rounded-md px-2 text-sm" onClick={() => props.onRename(props.project)}>
            {projectsText("projects.rename")}
          </button>
          <button type="button" class="min-h-11 rounded-md px-2 text-sm" onClick={() => props.onRemove(props.project)}>
            {projectsText("projects.remove")}
          </button>
        </div>
      </Show>
    </li>
  )
}
