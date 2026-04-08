import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { getFilename } from "@opencode-ai/util/path"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import { pagesApi, type Page, type PageQuery, type PageStatus } from "../../utils/pages-api"
import { isMarkdownPath } from "../utils/open-markdown-page-tab"
import { StatusEditorDialog } from "./status-editor-dialog"

type Project = {
  id: string
  name?: string | null
  worktree: string
  sandboxes?: string[]
}

type Scope = "all" | "project" | "global"

export type PageIndexProps = {
  scope: Scope
  directory?: string
  projects: Project[]
  onOpenPage: (page: Page) => void
}

function currentProject(list: Project[], dir?: string) {
  if (!dir) return
  return list.find((item) => item.worktree === dir || item.sandboxes?.includes(dir))
}

function query(scope: Scope, dir: string | undefined, filter: string): PageQuery {
  if (scope === "project") return { scope: "project", directory: dir }
  if (scope === "global") return { scope: "global" }
  if (filter === "all") return { scope: "all" }
  if (filter === "global") return { scope: "global" }
  return { scope: "project", project_id: filter }
}

function title(scope: Scope, dir?: string, project?: Project) {
  if (scope === "all") return "Pages"
  if (scope === "global") return "Global Pages"
  return project?.name || project?.worktree.split("/").at(-1) || dir?.split("/").at(-1) || "Project Pages"
}

function projectLabel(page: Page) {
  return page.project_name || page.project_worktree?.split("/").at(-1) || "Global"
}

function norm(value: string) {
  const txt = value.trim().replaceAll("\\", "/")
  if (!txt || txt === "/") return txt
  return txt.replace(/\/+$/, "")
}

function within(file: string, dir: string) {
  if (!file || !dir) return false
  if (file === dir) return true
  return file.startsWith(`${dir}/`)
}

function roots(project: Project) {
  return [project.worktree, ...(project.sandboxes ?? [])]
    .map(norm)
    .filter((item, idx, list) => !!item && list.indexOf(item) === idx)
}

function match(list: Project[], file: string) {
  let best: { project: Project; directory: string } | undefined
  for (const project of list) {
    for (const directory of roots(project)) {
      if (!within(file, directory)) continue
      if (!best || directory.length > best.directory.length) best = { project, directory }
    }
  }
  return best
}

function parent(file: string) {
  const txt = norm(file)
  const idx = txt.lastIndexOf("/")
  if (idx < 0) return ""
  if (idx === 0) return "/"
  if (idx === 2 && /^[a-z]:/i.test(txt)) return `${txt.slice(0, 2)}/`
  return txt.slice(0, idx)
}

export function PageIndex(props: PageIndexProps) {
  const dialog = useDialog()
  const globalSync = useGlobalSync()
  const platform = usePlatform()
  const [pages, setPages] = createSignal<Page[]>([])
  const [statuses, setStatuses] = createSignal<PageStatus[]>([])
  const [loading, setLoading] = createSignal(true)
  const [filter, setFilter] = createSignal("all")
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set())
  const project = createMemo(() => currentProject(props.projects, props.directory))
  const listQuery = createMemo(() => query(props.scope, props.directory, filter()))
  const canEdit = createMemo(() => !(props.scope === "all" && filter() === "all"))
  const filterOptions = createMemo(() => [
    { id: "all", label: "All pages" },
    { id: "global", label: "Global" },
    ...props.projects.map((item) => ({
      id: item.id,
      label: item.name || item.worktree.split("/").at(-1) || item.id,
    })),
  ])
  const createOptions = createMemo(() => {
    const list: Array<{ key: string; label: string; project_id?: string; directory?: string }> = []
    if (project()) {
      list.push({
        key: "current",
        label: "Current project",
        project_id: project()!.id,
        directory: props.directory || project()!.worktree,
      })
    }
    list.push({ key: "global", label: "Global" })
    for (const item of props.projects) {
      if (item.id === project()?.id) continue
      list.push({
        key: item.id,
        label: item.name || item.worktree.split("/").at(-1) || item.id,
        project_id: item.id,
        directory: item.worktree,
      })
    }
    return list
  })

  createEffect(() => {
    const next = listQuery()
    setLoading(true)
    void Promise.all([pagesApi.list(next), pagesApi.listStatuses(next)])
      .then(([pageList, statusList]) => {
        setPages(pageList)
        setStatuses(statusList)
      })
      .catch((err) => {
        showToast({
          title: "Failed to load pages",
          description: err instanceof Error ? err.message : String(err),
          variant: "error",
        })
      })
      .finally(() => setLoading(false))
  })

  const grouped = createMemo(() => {
    const list = pages()
    const rows = statuses().map((item) => ({
      status: item,
      pages: list.filter((page) => page.status === item.id),
    }))
    const ids = new Set(statuses().map((item) => item.id))
    const rest = list.filter((page) => !ids.has(page.status))
    if (!rest.length) return rows
    return [
      ...rows,
      {
        status: { id: "__unknown__", name: "Unknown", color: "#6b7280", position: 999, transitions: [] },
        pages: rest,
      },
    ]
  })

  const openStatusEditor = () => {
    if (!canEdit()) return
    dialog.show(() => (
      <StatusEditorDialog
        statuses={statuses()}
        onSave={async (next) => {
          const saved = await pagesApi.saveStatuses(next, listQuery())
          setStatuses(saved)
        }}
      />
    ))
  }

  const createPage = async (item: { project_id?: string; directory?: string }) => {
    try {
      const page = await pagesApi.create({
        title: "Untitled",
        project_id: item.project_id,
        directory: item.directory,
      })
      props.onOpenPage(page)
    } catch (err) {
      showToast({
        title: "Failed to create page",
        description: err instanceof Error ? err.message : String(err),
        variant: "error",
      })
    }
  }

  const importPage = async () => {
    if (!platform.openFilePickerDialog) {
      showToast({
        title: "Markdown import is only available on desktop",
        description: "Open a local markdown file directly to create a file-backed page.",
        variant: "error",
      })
      return
    }

    try {
      const raw = await platform.openFilePickerDialog({
        title: "Import Markdown",
        multiple: false,
      })
      const file = norm(Array.isArray(raw) ? raw[0] || "" : raw || "")
      if (!file) return
      if (!isMarkdownPath(file)) {
        showToast({
          title: "Choose a markdown file",
          description: "Pages import currently supports .md and .markdown files.",
          variant: "error",
        })
        return
      }

      let hit = match(props.projects, file)
      if (!hit) {
        const dir = parent(file)
        if (dir) {
          await globalSync.project.ensure(dir).catch(() => undefined)
          const list = await globalSync.project.reload().catch(() => props.projects)
          hit = match(list as Project[], file)
        }
      }

      const name = getFilename(file) || "Untitled"
      const page = await (async () => {
        if (hit) {
          const found = await pagesApi.findByFile(file, hit.directory)
          if (found) return found
          return pagesApi.create({
            title: name,
            file_path: file,
            directory: hit.directory,
            project_id: hit.project.id,
          })
        }

        const list = await pagesApi.list({ scope: "all" })
        const found = list.find((item) => item.file_path === file && !item.project_id)
        if (found) return found
        return pagesApi.create({
          title: name,
          file_path: file,
        })
      })()

      props.onOpenPage(page)
    } catch (err) {
      showToast({
        title: "Failed to import markdown",
        description: err instanceof Error ? err.message : String(err),
        variant: "error",
      })
    }
  }

  const movePage = async (pageId: string, status: string) => {
    setPages((list) => list.map((page) => (page.id === pageId ? { ...page, status } : page)))
    try {
      await pagesApi.transitionStatus(pageId, status)
    } catch (err) {
      showToast({
        title: "Failed to update status",
        description: err instanceof Error ? err.message : String(err),
        variant: "error",
      })
    }
  }

  const dropPage = async (pageId: string) => {
    const prev = pages()
    setPages((list) => list.filter((page) => page.id !== pageId))
    try {
      await pagesApi.delete(pageId)
    } catch (err) {
      setPages(prev)
      showToast({
        title: "Failed to delete page",
        description: err instanceof Error ? err.message : String(err),
        variant: "error",
      })
    }
  }

  const toggle = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div class="flex flex-col h-full overflow-hidden bg-background-base">
      <div class="flex-1 min-h-0 overflow-auto">
        <div style="width:min(100%,980px);margin:0 auto;padding:0 60px 120px;">
          <div style="margin-top:80px;margin-bottom:28px;">
            <div class="flex items-end justify-between gap-4">
              <div class="flex flex-col gap-2">
                <h1 style="font-size:40px;font-weight:700;line-height:1.1;letter-spacing:-0.02em;color:var(--text-strong);margin:0;">
                  {title(props.scope, props.directory, project())}
                </h1>
                <div class="flex items-center gap-3 text-14-regular" style="color:var(--text-weaker);">
                  <span>{pages().length} {pages().length === 1 ? "page" : "pages"}</span>
                  <Show when={props.scope === "all"}>
                    <label class="flex items-center gap-2">
                      <span>Filter</span>
                      <select
                        class="rounded-md border border-border-weak-base bg-background-base px-2 py-1 text-13-regular"
                        value={filter()}
                        onInput={(event) => setFilter(event.currentTarget.value)}
                      >
                        <For each={filterOptions()}>{(item) => <option value={item.id}>{item.label}</option>}</For>
                      </select>
                    </label>
                  </Show>
                </div>
              </div>
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  class="text-14-medium"
                  style="display:inline-flex;align-items:center;gap:8px;padding:9px 14px;border-radius:8px;border:1px solid var(--border-weak-base);background:var(--surface-base);color:var(--text-base);"
                  onClick={() => void importPage()}
                >
                  <Icon name="folder" size="small" />
                  <span>Import Markdown</span>
                </button>
                <DropdownMenu gutter={6} placement="bottom-end">
                  <DropdownMenu.Trigger
                    class="text-14-medium"
                    style="display:inline-flex;align-items:center;gap:8px;padding:9px 14px;border-radius:8px;border:1px solid var(--border-weak-base);background:var(--background-base);color:var(--text-base);"
                    aria-label="Create page"
                  >
                    <Icon name="plus" size="small" />
                    <span>New Page</span>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content>
                      <DropdownMenu.Group>
                        <DropdownMenu.GroupLabel>Create In</DropdownMenu.GroupLabel>
                        <For each={createOptions()}>
                          {(item) => (
                            <DropdownMenu.Item onSelect={() => void createPage(item)}>
                              <DropdownMenu.ItemLabel>{item.label}</DropdownMenu.ItemLabel>
                            </DropdownMenu.Item>
                          )}
                        </For>
                      </DropdownMenu.Group>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu>
                <IconButton
                  icon="settings-gear"
                  variant="ghost"
                  aria-label="Configure statuses"
                  disabled={!canEdit()}
                  onClick={openStatusEditor}
                />
              </div>
            </div>
          </div>

          <Show when={loading()}>
            <div class="flex items-center gap-3 py-16" style="color:var(--text-weak);">
              <div class="size-4 rounded-full border-2 border-current" style="border-top-color:transparent;animation:spin 0.6s linear infinite;" />
              <span class="text-14-regular">Loading pages...</span>
            </div>
          </Show>

          <Show when={!loading() && pages().length === 0}>
            <div class="rounded-xl border border-border-weak-base p-6" style="background:var(--surface-base);color:var(--text-weaker);">
              No pages yet in this view.
            </div>
          </Show>

          <Show when={!loading() && pages().length > 0}>
            <div class="flex flex-col gap-6">
              <For each={grouped()}>
                {(group) => (
                  <Show when={group.pages.length > 0}>
                    <section class="flex flex-col gap-2">
                      <button
                        type="button"
                        class="flex items-center gap-2 py-1 text-left"
                        onClick={() => toggle(group.status.id)}
                      >
                        <span class="inline-block size-2 rounded-sm" style={{ background: group.status.color }} />
                        <span class="text-12-medium text-text-base">{group.status.name}</span>
                        <span class="text-12-regular text-text-weaker">{group.pages.length}</span>
                      </button>
                      <Show when={!collapsed().has(group.status.id)}>
                        <div class="flex flex-col gap-2">
                          <For each={group.pages}>
                            {(page) => {
                              const moves = () => statuses().filter((item) => {
                                const current = statuses().find((row) => row.id === page.status)
                                if (!current) return true
                                return current.transitions.includes(item.id)
                              })
                              return (
                                <div
                                  class="group flex items-center gap-3 rounded-xl border border-border-weak-base px-4 py-3"
                                  style="background:var(--surface-base);"
                                >
                                  <button
                                    type="button"
                                    class="min-w-0 flex-1 text-left"
                                    onClick={() => props.onOpenPage(page)}
                                  >
                                    <div class="truncate text-14-medium text-text-base">{page.title || "Untitled"}</div>
                                    <div class="flex items-center gap-2 text-12-regular text-text-weaker">
                                      <Show when={props.scope === "all"}>
                                        <span>{projectLabel(page)}</span>
                                      </Show>
                                      <Show when={page.file_path}>
                                        <span class="truncate">{page.file_path}</span>
                                      </Show>
                                    </div>
                                  </button>
                                  <DropdownMenu gutter={4} placement="bottom-end">
                                    <DropdownMenu.Trigger
                                      class="rounded-md border border-border-weak-base px-2 py-1 text-12-regular text-text-weaker"
                                      aria-label="Page actions"
                                    >
                                      <span>{group.status.name}</span>
                                    </DropdownMenu.Trigger>
                                    <DropdownMenu.Portal>
                                      <DropdownMenu.Content>
                                        <DropdownMenu.Group>
                                          <DropdownMenu.GroupLabel>Move To</DropdownMenu.GroupLabel>
                                          <For each={moves()}>
                                            {(item) => (
                                              <DropdownMenu.Item onSelect={() => void movePage(page.id, item.id)}>
                                                <DropdownMenu.ItemLabel>{item.name}</DropdownMenu.ItemLabel>
                                              </DropdownMenu.Item>
                                            )}
                                          </For>
                                        </DropdownMenu.Group>
                                        <DropdownMenu.Separator />
                                        <DropdownMenu.Item onSelect={() => void dropPage(page.id)}>
                                          <DropdownMenu.ItemLabel>Delete</DropdownMenu.ItemLabel>
                                        </DropdownMenu.Item>
                                      </DropdownMenu.Content>
                                    </DropdownMenu.Portal>
                                  </DropdownMenu>
                                </div>
                              )
                            }}
                          </For>
                        </div>
                      </Show>
                    </section>
                  </Show>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </div>
  )
}
