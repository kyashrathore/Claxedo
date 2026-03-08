/**
 * PageIndex — Landing view listing all pages grouped by status.
 *
 * Fetches pages and status definitions on mount, groups pages by status,
 * and provides inline status transitions, create, delete, and open actions.
 */

import { createSignal, createMemo, createEffect, For, Show, onMount } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { pagesApi, type Page, type PageStatus } from "../../utils/pages-api"
import { StatusEditorDialog } from "./status-editor-dialog"

export type PageIndexProps = {
  onOpenPage: (pageId: string, title: string) => void
  onCreatePage: () => void
}

export function PageIndex(props: PageIndexProps) {
  const dialog = useDialog()
  const [pages, setPages] = createSignal<Page[]>([])
  const [statuses, setStatuses] = createSignal<PageStatus[]>([])
  const [loading, setLoading] = createSignal(true)
  const [openDropdown, setOpenDropdown] = createSignal<string | null>(null)

  const fetchData = async () => {
    setLoading(true)
    try {
      const [pageList, statusList] = await Promise.all([pagesApi.list(), pagesApi.listStatuses()])
      setPages(pageList)
      setStatuses(statusList)
    } catch (err) {
      showToast({
        title: "Failed to load pages",
        description: err instanceof Error ? err.message : String(err),
        variant: "error",
      })
    } finally {
      setLoading(false)
    }
  }

  onMount(fetchData)

  const grouped = createMemo(() => {
    const statusList = statuses()
    const pageList = pages()
    const groups: Array<{ status: PageStatus; pages: Page[] }> = []
    for (const status of statusList) {
      groups.push({
        status,
        pages: pageList.filter((p) => p.status === status.id),
      })
    }
    // Catch pages with unknown status
    const knownIds = new Set(statusList.map((s) => s.id))
    const orphans = pageList.filter((p) => !knownIds.has(p.status))
    if (orphans.length) {
      groups.push({
        status: { id: "__unknown__", name: "Unknown", color: "#6b7280", position: 999, transitions: [] },
        pages: orphans,
      })
    }
    return groups
  })

  const handleDelete = async (pageId: string) => {
    setPages((prev) => prev.filter((p) => p.id !== pageId))
    try {
      await pagesApi.delete(pageId)
    } catch (err) {
      showToast({
        title: "Failed to delete page",
        description: err instanceof Error ? err.message : String(err),
        variant: "error",
      })
      fetchData()
    }
  }

  const handleTransition = async (pageId: string, targetStatus: string) => {
    setOpenDropdown(null)
    setPages((prev) => prev.map((p) => (p.id === pageId ? { ...p, status: targetStatus } : p)))
    try {
      await pagesApi.transitionStatus(pageId, targetStatus)
    } catch (err) {
      showToast({
        title: "Failed to update status",
        description: err instanceof Error ? err.message : String(err),
        variant: "error",
      })
      fetchData()
    }
  }

  const handleCreate = async () => {
    try {
      const page = await pagesApi.create("Untitled")
      setPages((prev) => [page, ...prev])
      props.onOpenPage(page.id, page.title)
    } catch (err) {
      showToast({
        title: "Failed to create page",
        description: err instanceof Error ? err.message : String(err),
        variant: "error",
      })
    }
  }

  const openStatusEditor = () => {
    dialog.show(() => (
      <StatusEditorDialog
        statuses={statuses()}
        onSave={(updated) => {
          setStatuses(updated)
          fetchData()
        }}
      />
    ))
  }

  const formatDate = (iso: string) => {
    try {
      const d = new Date(iso)
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    } catch {
      return ""
    }
  }

  const allowedTransitions = (page: Page) => {
    const current = statuses().find((s) => s.id === page.status)
    if (!current) return statuses()
    return statuses().filter((s) => current.transitions.includes(s.id))
  }

  return (
    <div class="flex flex-col h-full overflow-auto" onClick={() => setOpenDropdown(null)}>
      {/* Header */}
      <div class="flex items-center justify-between px-4 py-3 border-b border-border-weak-base">
        <div class="flex items-center gap-2">
          <Icon name="page" size="small" class="text-icon-weak-base" />
          <span class="text-14-medium text-text-strong">Pages</span>
        </div>
        <div class="flex items-center gap-1">
          <IconButton icon="settings-gear" variant="ghost" onClick={openStatusEditor} aria-label="Configure statuses" />
          <IconButton icon="chevron-grabber-vertical" variant="ghost" onClick={fetchData} aria-label="Refresh" />
        </div>
      </div>

      {/* Content */}
      <div class="flex-1 overflow-auto px-4 py-3">
        <Show when={!loading()} fallback={
          <div class="flex items-center justify-center py-12">
            <div class="size-6 rounded-full border-2 border-text-weak border-t-transparent animate-spin" />
          </div>
        }>
          <Show when={pages().length > 0} fallback={
            <div class="flex flex-col items-center justify-center py-12 gap-3 text-text-weak">
              <Icon name="page" size="large" class="text-icon-weak-base" />
              <span class="text-12-regular">No pages yet</span>
              <button
                type="button"
                class="px-3 py-1.5 text-12-medium rounded-md bg-accent-base text-white hover:bg-accent-base/90 transition-colors"
                onClick={handleCreate}
              >
                + New Page
              </button>
            </div>
          }>
            <For each={grouped()}>
              {(group) => (
                <Show when={group.pages.length > 0}>
                  <div class="mb-4">
                    {/* Status header */}
                    <div class="flex items-center gap-2 mb-2">
                      <div
                        class="w-2 h-2 rounded-full shrink-0"
                        style={{ "background-color": group.status.color }}
                      />
                      <span class="text-12-medium text-text-base">{group.status.name}</span>
                      <span class="text-11-regular text-text-weaker">{group.pages.length}</span>
                    </div>

                    {/* Page rows */}
                    <div class="flex flex-col gap-0.5">
                      <For each={group.pages}>
                        {(page) => (
                          <div class="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-surface-base-hover group/row transition-colors">
                            <Icon name="page" size="small" class="shrink-0 text-icon-weak-base" />

                            {/* Clickable title */}
                            <button
                              type="button"
                              class="flex-1 text-left text-12-regular text-text-base hover:text-text-strong truncate"
                              onClick={() => props.onOpenPage(page.id, page.title)}
                            >
                              {page.title || "Untitled"}
                            </button>

                            {/* Status badge / dropdown */}
                            <div class="relative">
                              <button
                                type="button"
                                class="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors hover:opacity-80"
                                style={{
                                  "background-color": `${group.status.color}20`,
                                  color: group.status.color,
                                }}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setOpenDropdown((prev) => (prev === page.id ? null : page.id))
                                }}
                              >
                                {group.status.name}
                                <Show when={allowedTransitions(page).length > 0}>
                                  <Icon name="chevron-down" size="small" />
                                </Show>
                              </button>

                              {/* Transition dropdown */}
                              <Show when={openDropdown() === page.id && allowedTransitions(page).length > 0}>
                                <div
                                  class="absolute right-0 top-full mt-1 z-50 min-w-[140px] rounded-md border border-border-weak-base bg-background-base shadow-lg py-1"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <For each={allowedTransitions(page)}>
                                    {(target) => (
                                      <button
                                        type="button"
                                        class="flex items-center gap-2 w-full px-3 py-1.5 text-left text-[11px] hover:bg-surface-base-hover transition-colors"
                                        onClick={() => handleTransition(page.id, target.id)}
                                      >
                                        <div
                                          class="w-2 h-2 rounded-full shrink-0"
                                          style={{ "background-color": target.color }}
                                        />
                                        <span class="text-text-base">{target.name}</span>
                                      </button>
                                    )}
                                  </For>
                                </div>
                              </Show>
                            </div>

                            {/* Date */}
                            <span class="text-[10px] text-text-weaker whitespace-nowrap">
                              {formatDate(page.updated_at)}
                            </span>

                            {/* Delete */}
                            <button
                              type="button"
                              class="opacity-0 group-hover/row:opacity-100 transition-opacity text-text-weaker hover:text-red-500"
                              onClick={(e) => {
                                e.stopPropagation()
                                handleDelete(page.id)
                              }}
                              aria-label="Delete page"
                            >
                              <Icon name="close-small" size="small" />
                            </button>
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>
              )}
            </For>
          </Show>
        </Show>
      </div>

      {/* Footer */}
      <Show when={pages().length > 0}>
        <div class="shrink-0 border-t border-border-weak-base px-4 py-2">
          <button
            type="button"
            class="flex items-center gap-1.5 text-12-regular text-text-weak hover:text-text-base transition-colors"
            onClick={handleCreate}
          >
            <Icon name="plus" size="small" />
            <span>New Page</span>
          </button>
        </div>
      </Show>
    </div>
  )
}
