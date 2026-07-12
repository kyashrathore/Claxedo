import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { ensureLocalProject, useGlobalSDK, useShellQueryOptions as useQueryOptions } from "@/features/documents/app-ports"
import { queryClient } from "@/platform/query/query-client"
import { pagesApi, type Page, type PageQuery, type PageStatus } from "@/features/documents/data/pages-api"
import { StatusEditorDialog } from "./status-editor-dialog"

type Project = {
  id: string
  name?: string | null
  worktree: string
  sandboxes?: string[]
}

type Scope = "all" | "project" | "global"

export type PageStatusGroup = { status: PageStatus; pages: Page[] }

export const UNKNOWN_PAGE_STATUS: PageStatus = {
  id: "__unknown__",
  name: "Unknown",
  color: "#6b7280",
  position: 999,
  transitions: [],
}

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

function query(scope: Scope, dir: string | undefined): PageQuery {
  if (scope === "project") return { scope: "project", directory: dir }
  if (scope === "global") return { scope: "global" }
  return { scope: "all" }
}

function title() {
  return "Pages"
}

function provenanceKey(page: Page) {
  if (page.source_repo_key) return `repo:${page.source_repo_key}`
  if (page.source_repo_root) return `repo-root:${page.source_repo_root}`
  if (page.source_path) return `file:${parent(page.source_path)}`
  if (page.directory || page.project_worktree) return `workspace:${page.directory || page.project_worktree}`
  return "unsourced"
}

function provenanceLabel(page: Page) {
  if (page.source_path && page.source_repo_root) {
    return page.source_branch ? `${page.source_path} · ${page.source_branch}` : page.source_path
  }
  if (page.source_path) return page.source_path
  if (page.source_repo_root) return page.source_repo_root
  if (page.directory || page.project_worktree) return "Workspace page"
  return "Unsourced"
}

function provenanceFilterLabel(page: Page) {
  if (page.source_repo_root) return page.source_branch ? `Git: ${page.source_repo_root} · ${page.source_branch}` : `Git: ${page.source_repo_root}`
  if (page.source_path) return `File: ${parent(page.source_path) || page.source_path}`
  if (page.directory || page.project_worktree) return "Workspace pages"
  return "Unsourced"
}

function parent(value: string) {
  const txt = value.trim().replaceAll("\\", "/")
  if (!txt) return ""
  const trimmed = txt.replace(/\/+$/, "")
  const idx = trimmed.lastIndexOf("/")
  if (idx < 0) return ""
  if (idx === 0) return "/"
  if (idx === 2 && /^[a-z]:/i.test(trimmed)) return `${trimmed.slice(0, 2)}/`
  return trimmed.slice(0, idx)
}

export function groupPagesByStatus(pages: Page[], statuses: PageStatus[]): PageStatusGroup[] {
  const rows = statuses.map((item) => ({
    status: item,
    pages: pages.filter((page) => page.status === item.id),
  }))
  const ids = new Set(statuses.map((item) => item.id))
  const rest = pages.filter((page) => !ids.has(page.status))
  if (!rest.length) return rows
  return [
    ...rows,
    {
      status: UNKNOWN_PAGE_STATUS,
      pages: rest,
    },
  ]
}

export function allowedPageStatusTransitions(page: Page, statuses: PageStatus[]) {
  const current = statuses.find((item) => item.id === page.status)
  if (!current) return statuses
  return statuses.filter((item) => current.transitions.includes(item.id))
}

/** Optimistic list transform for a status move: rewrite the page's status in place. */
export function optimisticMovePage(pages: Page[], pageId: string, status: string): Page[] {
  return pages.map((page) => (page.id === pageId ? { ...page, status } : page))
}

/** Optimistic list transform for a delete: drop the page from the list. */
export function optimisticDropPage(pages: Page[], pageId: string): Page[] {
  return pages.filter((page) => page.id !== pageId)
}

/**
 * Apply an optimistic page-list mutation and then commit it. The list is
 * mutated immediately from its current snapshot; if the commit rejects, the
 * list is rolled back to that exact pre-mutation snapshot and `onError` fires.
 * This is the shared engine behind PageIndex.movePage / PageIndex.dropPage — a
 * commit failure must never leave the optimistic edit stuck on screen.
 */
export async function runOptimisticPageMutation(input: {
  getPages: () => Page[]
  setPages: (next: Page[]) => void
  optimistic: (pages: Page[]) => Page[]
  commit: () => Promise<unknown>
  onError: (err: unknown) => void
}): Promise<void> {
  const prev = input.getPages()
  input.setPages(input.optimistic(prev))
  try {
    await input.commit()
  } catch (err) {
    input.setPages(prev)
    input.onError(err)
  }
}

export function PageIndex(props: PageIndexProps) {
  const dialog = useDialog()
  const globalSDK = useGlobalSDK()
  const platform = usePlatform()
  const queryOptions = useQueryOptions()
  const [pages, setPages] = createSignal<Page[]>([])
  const [statuses, setStatuses] = createSignal<PageStatus[]>([])
  const [loading, setLoading] = createSignal(true)
  const [filter, setFilter] = createSignal("all")
  const [collapsed, setCollapsed] = createSignal(new Set())
  const projects = createMemo(() => queryClient.getQueryData<Project[]>(queryOptions.projects().queryKey) ?? props.projects)
  const project = createMemo(() => currentProject(projects(), props.directory))
  const listQuery = createMemo(() => query(props.scope, props.directory))
  const canEdit = createMemo(() => props.scope !== "all")
  const filterOptions = createMemo(() => {
    const seen = new Set<string>()
    const options = [{ id: "all", label: "All pages" }]
    for (const page of pages()) {
      const id = provenanceKey(page)
      if (seen.has(id)) continue
      seen.add(id)
      options.push({ id, label: provenanceFilterLabel(page) })
    }
    return options
  })
  const visiblePages = createMemo(() => filter() === "all" ? pages() : pages().filter((page) => provenanceKey(page) === filter()))

  let loadSeq = 0
  const loadPages = (showLoading = true) => {
    const next = listQuery()
    const seq = ++loadSeq
    if (showLoading) setLoading(true)
    void Promise.all([pagesApi.list(next), pagesApi.listStatuses(next)])
      .then(([pageList, statusList]) => {
        if (seq !== loadSeq) return
        setPages(pageList)
        setStatuses(statusList)
      })
      .catch((err) => {
        if (seq !== loadSeq) return
        showToast({
          title: "Failed to load pages",
          description: err instanceof Error ? err.message : String(err),
          variant: "error",
        })
      })
      .finally(() => {
        if (showLoading && seq === loadSeq) setLoading(false)
      })
  }

  createEffect(() => {
    loadPages()
  })

  createEffect(() => {
    const next = listQuery()
    const abort = new AbortController()
    const watch = (pagesApi as typeof pagesApi & {
      watchListEvents?: (input: PageQuery | undefined, onChange: () => void, signal?: AbortSignal) => Promise<void>
    }).watchListEvents
    if (watch) void watch(next, () => loadPages(false), abort.signal).catch(() => {})
    onCleanup(() => abort.abort())
  })

  const grouped = createMemo(() => groupPagesByStatus(visiblePages(), statuses()))

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

  const createPage = async () => {
    try {
      if (props.directory) {
        await ensureLocalProject({
          baseUrl: globalSDK.url,
          request: platform.fetch,
          directory: props.directory,
          projectsQuery: queryOptions.projects(),
        })
      }
      const page = await pagesApi.create({
        title: "Untitled",
        project_id: project()?.id,
        directory: props.directory || project()?.worktree,
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

  const movePage = (pageId: string, status: string) =>
    runOptimisticPageMutation({
      getPages: pages,
      setPages,
      optimistic: (list) => optimisticMovePage(list, pageId, status),
      commit: () => pagesApi.transitionStatus(pageId, status),
      onError: (err) =>
        showToast({
          title: "Failed to update status",
          description: err instanceof Error ? err.message : String(err),
          variant: "error",
        }),
    })

  const dropPage = (pageId: string) =>
    runOptimisticPageMutation({
      getPages: pages,
      setPages,
      optimistic: (list) => optimisticDropPage(list, pageId),
      commit: () => pagesApi.delete(pageId),
      onError: (err) =>
        showToast({
          title: "Failed to delete page",
          description: err instanceof Error ? err.message : String(err),
          variant: "error",
        }),
    })

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
                  {title()}
                </h1>
                <div class="flex items-center gap-3 text-14-regular" style="color:var(--text-weaker);">
                  <span>{visiblePages().length} {visiblePages().length === 1 ? "page" : "pages"}</span>
                  <Show when={filterOptions().length > 1}>
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
                  style="display:inline-flex;align-items:center;gap:8px;padding:9px 14px;border-radius:8px;border:1px solid var(--border-weak-base);background:var(--background-base);color:var(--text-base);"
                  aria-label="Create page"
                  onClick={() => void createPage()}
                >
                  <Icon name="plus" size="small" />
                  <span>New Page</span>
                </button>
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

          <Show when={!loading() && visiblePages().length === 0}>
            <div class="rounded-xl border border-border-weak-base p-6" style="background:var(--surface-base);color:var(--text-weaker);">
              No pages yet in this view.
            </div>
          </Show>

          <Show when={!loading() && visiblePages().length > 0}>
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
                              const moves = () => allowedPageStatusTransitions(page, statuses())
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
                                      <span class="truncate">{provenanceLabel(page)}</span>
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
