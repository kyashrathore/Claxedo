import { createMemo, createSignal } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useServer } from "@/server"
import { useDialog, Dialog, FileIcon, List, type ListRef, DialogBody, DialogHeader, DialogTitle } from "@/ui"
import { getDirectory, getFilename } from "@/ui/utils"
import { cleanInput, displayPath, toRow, uniqueRows } from "../folder-paths"
import { createFolderSearch } from "../folder-search"
import { useProjectsText } from "../i18n"
import { useProjects } from "../store"

export interface DialogSelectDirectoryProps {
  onSelect: (result: string) => void
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
    props.onSelect(absolute)
    dialog.close()
  }

  return (
    <Dialog size="large" fit class="theme-directory-picker overlay-palette" containerClass="long-dialog-container">
      <DialogHeader>
        <DialogTitle>{t("projects.directory.title")}</DialogTitle>
      </DialogHeader>
      <DialogBody>
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
      </DialogBody>
    </Dialog>
  )
}
