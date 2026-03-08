/**
 * PageIndex — Landing view listing all pages grouped by status.
 *
 * Notion-style layout centered in the viewport with generous whitespace,
 * collapsible status groups, and refined inline status transitions.
 */

import { createSignal, createMemo, For, Show, onMount } from "solid-js"
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
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set())

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
      const now = new Date()
      const diffMs = now.getTime() - d.getTime()
      const diffMin = Math.floor(diffMs / 60_000)
      if (diffMin < 1) return "just now"
      if (diffMin < 60) return `${diffMin}m ago`
      const diffHr = Math.floor(diffMin / 60)
      if (diffHr < 24) return `${diffHr}h ago`
      const diffDay = Math.floor(diffHr / 24)
      if (diffDay < 7) return `${diffDay}d ago`
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

  const MAX_VISIBLE = 8

  const [expanded, setExpanded] = createSignal<Set<string>>(new Set())
  const isExpanded = (id: string) => expanded().has(id)
  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleCollapse = (statusId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(statusId)) next.delete(statusId)
      else next.add(statusId)
      return next
    })
  }

  return (
    <div
      class="flex flex-col h-full overflow-hidden bg-background-base"
      onClick={() => setOpenDropdown(null)}
    >
      {/* Scrollable content area — Notion-style centered shell */}
      <div class="flex-1 min-h-0 overflow-auto">
        <div style="width: min(100%, 920px); margin: 0 auto; padding: 0 60px;">

          {/* Title area — mirrors notion-title spacing */}
          <div style="margin-top: 80px; margin-bottom: 32px;">
            <div class="flex items-center justify-between">
              <h1 style="font-size: 40px; font-weight: 700; line-height: 1.2; letter-spacing: -0.02em; color: var(--text-strong); margin: 0;">
                Pages
              </h1>
              <div class="flex items-center gap-1" style="margin-top: 8px;">
                <IconButton icon="settings-gear" variant="ghost" onClick={openStatusEditor} aria-label="Configure statuses" />
              </div>
            </div>
            <Show when={!loading() && pages().length > 0}>
              <p style="font-size: 14px; color: var(--text-weaker); margin-top: 4px;">
                {pages().length} {pages().length === 1 ? "page" : "pages"}
              </p>
            </Show>
          </div>

          {/* Loading state */}
          <Show when={loading()}>
            <div class="flex items-center gap-3 py-16" style="color: var(--text-weak);">
              <div class="size-4 rounded-full border-2 border-current" style="border-top-color: transparent; animation: spin 0.6s linear infinite;" />
              <span class="text-14-regular">Loading pages...</span>
            </div>
          </Show>

          {/* Empty state */}
          <Show when={!loading() && pages().length === 0}>
            <div style="padding: 48px 0;">
              <p class="text-14-regular" style="color: var(--text-weak); margin-bottom: 20px;">
                No pages yet. Create your first page to get started.
              </p>
              <button
                type="button"
                class="text-14-medium"
                style="display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border-radius: 6px; border: 1px solid var(--border-weak-base); color: var(--text-base); background: var(--background-base); cursor: pointer; transition: all 150ms ease;"
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--surface-base-hover)"
                  e.currentTarget.style.borderColor = "var(--border-strong-base)"
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "var(--background-base)"
                  e.currentTarget.style.borderColor = "var(--border-weak-base)"
                }}
                onClick={handleCreate}
              >
                <Icon name="plus" size="small" />
                New Page
              </button>
            </div>
          </Show>

          {/* Status groups */}
          <Show when={!loading() && pages().length > 0}>
            <div style="display: flex; flex-direction: column; gap: 8px; padding-bottom: 120px;">
              <For each={grouped()}>
                {(group) => {
                  const isCollapsed = () => collapsed().has(group.status.id)
                  const count = () => group.pages.length
                  const visiblePages = createMemo(() => {
                    if (isExpanded(group.status.id) || group.pages.length <= MAX_VISIBLE) return group.pages
                    return group.pages.slice(0, MAX_VISIBLE)
                  })
                  const hiddenCount = createMemo(() => group.pages.length - visiblePages().length)
                  return (
                    <Show when={count() > 0}>
                      <div>
                        {/* Status group header */}
                        <button
                          type="button"
                          style="display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 0; border: none; background: none; cursor: pointer; user-select: none;"
                          onClick={() => toggleCollapse(group.status.id)}
                        >
                          <div
                            style={`width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; background-color: ${group.status.color};`}
                          />
                          <span class="text-12-medium" style="color: var(--text-base);">
                            {group.status.name}
                          </span>
                          <span
                            class="text-12-regular"
                            style="color: var(--text-weaker); min-width: 16px;"
                          >
                            {count()}
                          </span>
                          <div style="flex: 1;" />
                          <div
                            style={`transition: transform 150ms ease; transform: rotate(${isCollapsed() ? "-90deg" : "0deg"}); color: var(--text-weaker);`}
                          >
                            <Icon name="chevron-down" size="small" />
                          </div>
                        </button>

                        {/* Page rows */}
                        <Show when={!isCollapsed()}>
                          <div style="display: flex; flex-direction: column; gap: 1px; margin-left: 16px; border-left: 1px solid var(--border-weak-base); padding-left: 12px; margin-bottom: 4px;">
                            <For each={visiblePages()}>
                              {(page) => (
                                <div
                                  class="group/row"
                                  style="display: flex; align-items: center; gap: 10px; padding: 5px 8px; border-radius: 5px; transition: background-color 120ms ease; cursor: pointer;"
                                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--surface-base-hover)" }}
                                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent" }}
                                  onClick={() => props.onOpenPage(page.id, page.title)}
                                >
                                  {/* Page icon */}
                                  <div style="flex-shrink: 0; color: var(--icon-weak-base);">
                                    <Icon name="page" size="small" />
                                  </div>

                                  {/* Title */}
                                  <span
                                    class="text-14-regular"
                                    style="flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-base);"
                                  >
                                    {page.title || "Untitled"}
                                  </span>

                                  {/* Status badge with transition dropdown */}
                                  <div style="position: relative; flex-shrink: 0;" onClick={(e) => e.stopPropagation()}>
                                    <button
                                      type="button"
                                      style={`display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px; border: none; font-size: 11px; font-weight: 500; letter-spacing: 0.01em; cursor: pointer; transition: opacity 120ms ease; background-color: ${group.status.color}14; color: ${group.status.color};`}
                                      onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.75" }}
                                      onMouseLeave={(e) => { e.currentTarget.style.opacity = "1" }}
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        if (allowedTransitions(page).length > 0) {
                                          setOpenDropdown((prev) => (prev === page.id ? null : page.id))
                                        }
                                      }}
                                    >
                                      <div
                                        style={`width: 6px; height: 6px; border-radius: 50%; background-color: ${group.status.color};`}
                                      />
                                      {group.status.name}
                                      <Show when={allowedTransitions(page).length > 0}>
                                        <Icon name="chevron-down" size="small" />
                                      </Show>
                                    </button>

                                    {/* Dropdown */}
                                    <Show when={openDropdown() === page.id && allowedTransitions(page).length > 0}>
                                      <div
                                        style="position: absolute; right: 0; top: calc(100% + 4px); z-index: 50; min-width: 160px; border-radius: 8px; border: 1px solid var(--border-weak-base); background: var(--background-base); box-shadow: 0 8px 24px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.06); padding: 4px; animation: pageindex-dropdown-in 120ms ease;"
                                        onClick={(e) => e.stopPropagation()}
                                      >
                                        <div style="padding: 4px 8px 6px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-weaker);">
                                          Move to
                                        </div>
                                        <For each={allowedTransitions(page)}>
                                          {(target) => (
                                            <button
                                              type="button"
                                              style="display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; border: none; border-radius: 5px; background: none; text-align: left; font-size: 12px; cursor: pointer; transition: background-color 100ms ease; color: var(--text-base);"
                                              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--surface-base-hover)" }}
                                              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent" }}
                                              onClick={() => handleTransition(page.id, target.id)}
                                            >
                                              <div
                                                style={`width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; background-color: ${target.color};`}
                                              />
                                              <span>{target.name}</span>
                                            </button>
                                          )}
                                        </For>
                                      </div>
                                    </Show>
                                  </div>

                                  {/* Relative date */}
                                  <span
                                    class="text-12-regular"
                                    style="flex-shrink: 0; color: var(--text-weaker); white-space: nowrap;"
                                  >
                                    {formatDate(page.updated_at)}
                                  </span>

                                  {/* Delete */}
                                  <button
                                    type="button"
                                    class="opacity-0 group-hover/row:opacity-100"
                                    style="flex-shrink: 0; border: none; background: none; padding: 2px; cursor: pointer; color: var(--text-weaker); transition: color 120ms ease, opacity 120ms ease; border-radius: 3px;"
                                    onMouseEnter={(e) => { e.currentTarget.style.color = "#ef4444" }}
                                    onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-weaker)" }}
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
                            <Show when={hiddenCount() > 0}>
                              <button
                                type="button"
                                class="text-12-regular"
                                style="padding: 4px 8px; border: none; background: none; cursor: pointer; color: var(--text-weak); text-align: left; transition: color 120ms ease;"
                                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-base)" }}
                                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-weak)" }}
                                onClick={() => toggleExpanded(group.status.id)}
                              >
                                {hiddenCount()} more...
                              </button>
                            </Show>
                            <Show when={isExpanded(group.status.id) && group.pages.length > MAX_VISIBLE}>
                              <button
                                type="button"
                                class="text-12-regular"
                                style="padding: 4px 8px; border: none; background: none; cursor: pointer; color: var(--text-weak); text-align: left; transition: color 120ms ease;"
                                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-base)" }}
                                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-weak)" }}
                                onClick={() => toggleExpanded(group.status.id)}
                              >
                                Show less
                              </button>
                            </Show>
                          </div>
                        </Show>
                      </div>
                    </Show>
                  )
                }}
              </For>

              {/* New page row — inline with content */}
              <button
                type="button"
                style="display: flex; align-items: center; gap: 8px; padding: 6px 8px; margin-left: 16px; border: none; background: none; cursor: pointer; border-radius: 5px; transition: background-color 120ms ease; color: var(--text-weak);"
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = "var(--surface-base-hover)"
                  e.currentTarget.style.color = "var(--text-base)"
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "transparent"
                  e.currentTarget.style.color = "var(--text-weak)"
                }}
                onClick={handleCreate}
              >
                <Icon name="plus" size="small" />
                <span class="text-14-regular">New Page</span>
              </button>
            </div>
          </Show>
        </div>
      </div>

      <style>{`
        @keyframes pageindex-dropdown-in {
          from { opacity: 0; transform: translateY(-4px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  )
}
