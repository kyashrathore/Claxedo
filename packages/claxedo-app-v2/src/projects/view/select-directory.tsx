import { FileIcon } from "@opencode-ai/ui/file-icon"
import { List, type ListRef } from "@opencode-ai/ui/list"
import { getDirectory, getFilename } from "@opencode-ai/ui/utils/path"
import { createMemo, createSignal } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useServer } from "@/server"
import { ClaxedoIconV2, useDialog, Dialog } from "@/ui"
import { cleanInput, displayPath, toRow, uniqueRows } from "../folder-paths"
import { createFolderSearch } from "../folder-search"
import { useProjectsText } from "../i18n"
import { useProjects } from "../store"

export interface DialogSelectDirectoryProps {
  title?: string
  multiple?: boolean
  onSelect: (result: string | string[] | null) => void
}

export function DialogSelectDirectory(props: DialogSelectDirectoryProps) {
  const server = useServer()
  const dialog = useDialog()
  const t = useProjectsText()
  const projects = useProjects()
  const [filter, setFilter] = createSignal("")
  let list: ListRef | undefined

  const pathQuery = useQuery(() => server.queries.folders.paths())
  const home = createMemo(() => pathQuery.data?.home || "")
  const start = createMemo(() => pathQuery.data?.home || pathQuery.data?.directory)
  const directories = createFolderSearch({ server, home, start })
  const recentProjects = createMemo(() => {
    const state = projects()
    const listed = state.kind === "ready" ? state.data : []
    return listed.flatMap((project) => (project.source?.kind === "folder" ? [{ name: project.name, worktree: project.source.path }] : [])).slice(0, 5).map((project) => {
      const row = toRow(project.worktree, home(), "recent")
      return { ...row, search: `${row.search}\n${project.name || getFilename(project.worktree)}` }
    })
  })
  const items = async (value: string) =>
    uniqueRows([...recentProjects(), ...(await directories(value)).map((absolute) => toRow(absolute, home(), "folders"))])

  function resolve(absolute: string) {
    props.onSelect(props.multiple ? [absolute] : absolute)
    dialog.close()
  }

  return (
    <Dialog
      flush
      title={props.title ?? t("projects.directory.title")}
      class="theme-directory-picker overlay-palette"
      action={
        <button
          type="button"
          aria-label={t("projects.close")}
          class="inline-flex size-7 items-center justify-center rounded-md border-0 bg-transparent p-0 leading-none text-icon-weak-base transition-[background-color,color] duration-100 hover:bg-surface-base-hover hover:text-icon-strong-base focus-visible:bg-surface-base-hover focus-visible:text-icon-strong-base focus-visible:outline-none"
          onClick={() => dialog.close()}
        >
          <ClaxedoIconV2 name="close-small" size="small" />
        </button>
      }
    >
      <List
        search={{ placeholder: t("projects.directory.search"), autofocus: true }}
        emptyMessage={t("projects.directory.empty")}
        loadingMessage={t("projects.loading")}
        items={items}
        key={(x) => x.absolute}
        filterKeys={["search"]}
        groupBy={(item) => item.group}
        sortGroupsBy={(a, b) => a.category === b.category ? 0 : a.category === "recent" ? -1 : 1}
        groupHeader={(group) => group.category === "recent" ? t("projects.directory.recent") : t("projects.directory.title")}
        ref={(r) => (list = r)}
        onFilter={(value) => setFilter(cleanInput(value))}
        onKeyEvent={(e, item) => {
          if (e.key !== "Tab" || e.shiftKey || !item) return
          e.preventDefault()
          e.stopPropagation()
          const value = displayPath(item.absolute, filter(), home())
          list?.setFilter(value.endsWith("/") ? value : value + "/")
        }}
        onSelect={(path) => path && resolve(path.absolute)}
      >
        {(item) => {
          const path = displayPath(item.absolute, filter(), home())
          return (
            <div class="w-full flex items-center justify-between rounded-md">
              <div class="flex items-center gap-x-3 grow min-w-0">
                <FileIcon node={{ path: item.absolute, type: "directory" }} class="shrink-0 size-4" />
                <div class="flex items-center text-14-regular min-w-0">
                  <span class="text-text-weak whitespace-nowrap overflow-hidden overflow-ellipsis truncate min-w-0">
                    {path === "~" ? "" : getDirectory(path)}
                  </span>
                  <span class="text-text-strong whitespace-nowrap">{path === "~" ? "~" : getFilename(path)}</span>
                  <span class="text-text-weak whitespace-nowrap">/</span>
                </div>
              </div>
            </div>
          )
        }}
      </List>
    </Dialog>
  )
}
