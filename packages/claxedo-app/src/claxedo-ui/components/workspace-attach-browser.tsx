import { For, Show, createMemo, createSignal } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"

export type WorkspaceAttachProject = {
  id: string
  name?: string
  worktree: string
}

export type WorkspaceAttachItem = {
  id: string
  name: string
  directory: string
  projectId: string
  projectName: string
  isMain: boolean
  isCloud: boolean
}

export function WorkspaceAttachBrowser(props: {
  projects: WorkspaceAttachProject[]
  items: WorkspaceAttachItem[]
  currentDirectory?: string
  onSelect: (projectId: string, directory: string) => void
  onCreateProject: (projectId: string, projectName: string) => void
}) {
  const [filterText, setFilterText] = createSignal("")

  const groupedByProject = createMemo(() => {
    const groups: Array<{
      project: WorkspaceAttachProject
      projectName: string
      workspaces: WorkspaceAttachItem[]
    }> = []
    const filter = filterText().toLowerCase()
    for (const project of props.projects) {
      const items = props.items.filter((item) => item.projectId === project.id)
      const projectName = items[0]?.projectName ?? project.name ?? project.worktree.split("/").at(-1) ?? project.worktree
      const filtered = items.filter(
        (item) => !filter || item.name.toLowerCase().includes(filter) || projectName.toLowerCase().includes(filter),
      )
      if (filtered.length > 0 || projectName.toLowerCase().includes(filter)) {
        groups.push({ project, projectName, workspaces: filtered })
      }
    }
    return groups
  })

  return (
    <div class="flex flex-col max-h-[400px] overflow-hidden">
      <div class="flex items-center gap-2 px-3 py-2 border-b border-border-weak-base/50">
        <Icon name="magnifying-glass" size="small" class="text-icon-weak-base shrink-0" />
        <input
          type="text"
          placeholder="Filter workspaces..."
          value={filterText()}
          onInput={(event) => setFilterText(event.currentTarget.value)}
          class="flex-1 bg-transparent border-none outline-none text-[13px] text-text-base placeholder:text-text-weaker"
          autofocus
        />
      </div>
      <div class="overflow-y-auto flex-1">
        <For each={groupedByProject()}>
          {(group) => (
            <div class="py-1">
              <div class="flex items-center justify-between px-3 py-1">
                <span class="text-[11px] font-medium text-text-weaker uppercase tracking-wider truncate">
                  {group.projectName}
                </span>
                <button
                  type="button"
                  class="flex items-center justify-center size-5 rounded text-icon-weak-base hover:text-icon-base hover:bg-surface-base-hover transition-colors cursor-pointer border-none bg-transparent"
                  onClick={(event) => {
                    event.stopPropagation()
                    props.onCreateProject(group.project.id, group.projectName)
                  }}
                  aria-label={`Add workspace to ${group.projectName}`}
                >
                  <Icon name="plus-small" size="small" />
                </button>
              </div>
              <For each={group.workspaces}>
                {(workspace) => (
                  <button
                    type="button"
                    class="flex items-center gap-2 w-full px-3 py-1.5 text-left hover:bg-surface-base-hover transition-colors cursor-pointer border-none bg-transparent"
                    classList={{ "bg-surface-base-hover/50": props.currentDirectory === workspace.directory }}
                    onClick={() => props.onSelect(workspace.projectId, workspace.directory)}
                  >
                    <Icon name={workspace.isCloud ? "cloud" : "laptop"} size="small" class="text-icon-weak-base shrink-0" />
                    <span class="text-[13px] text-text-base truncate flex-1">{workspace.name}</span>
                    <Show when={props.currentDirectory === workspace.directory}>
                      <Icon name="check-small" size="small" class="text-icon-base shrink-0" />
                    </Show>
                  </button>
                )}
              </For>
            </div>
          )}
        </For>
        <Show when={!groupedByProject().length}>
          <div class="px-3 py-6 text-[12px] text-text-weaker text-center">
            No workspaces match your filter.
          </div>
        </Show>
      </div>
    </div>
  )
}
