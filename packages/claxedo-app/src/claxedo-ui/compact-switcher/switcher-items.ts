import type { ClaxedoStateApi } from "../state/provider"
import type { ContentMeta, ContentType } from "../state/types"

export type SwitcherStatus = "idle" | "working" | "permission" | "done"
export type SwitcherKind = "session" | "terminal" | "browser" | "review" | "file" | "processes" | "page" | "workgraph"

export type SwitcherItem = {
  contentId: string
  kind: SwitcherKind
  title: string
  workspaceDir?: string
  active: boolean
  status?: SwitcherStatus
}

export type SwitcherGroup = {
  id: string
  label: string
  projectLabel?: string
  workspaceDir?: string
  items: SwitcherItem[]
  hiddenItems: SwitcherItem[]
  hiddenCount: number
  hiddenAttentionCount: number
}

export type SwitcherWorkspaceLabel = {
  workspaceLabel: string
  projectLabel?: string
}

export function buildSwitcherGroups(input: {
  items: SwitcherItem[]
  maxPerWorkspace?: number
  recentContentIds?: readonly string[]
  labelForWorkspace?: (workspaceDir: string | undefined) => SwitcherWorkspaceLabel
}): SwitcherGroup[] {
  const max = input.maxPerWorkspace ?? 5
  const grouped = input.items.reduce((acc, item) => {
    const key = item.workspaceDir ?? "__global__"
    acc.set(key, [...(acc.get(key) ?? []), item])
    return acc
  }, new Map<string, SwitcherItem[]>())

  return [...grouped.entries()].map(([key, items]) => {
    const workspaceDir = key === "__global__" ? undefined : key
    const labels = input.labelForWorkspace?.(workspaceDir) ?? {
      workspaceLabel: workspaceDir?.split("/").at(-1) || "Global",
    }
    const visible = visibleItems(items, max, input.recentContentIds)
    const visibleIds = new Set(visible.map((item) => item.contentId))
    const hiddenItems = items.filter((item) => !visibleIds.has(item.contentId))
    return {
      id: key,
      label: labels.workspaceLabel,
      projectLabel: labels.projectLabel,
      workspaceDir,
      items: visible,
      hiddenItems,
      hiddenCount: hiddenItems.length,
      hiddenAttentionCount: hiddenItems.filter(itemNeedsAttention).length,
    }
  })
}

export function itemNeedsAttention(item: SwitcherItem): boolean {
  return item.status === "permission" || item.status === "done"
}

function mapKindFromMeta(type: ContentType): SwitcherKind {
  switch (type) {
    case "session":
    case "draft-session":
      return "session"
    case "terminal":
      return "terminal"
    case "page":
    case "pages-index":
      return "page"
    case "workgraph":
      return "workgraph"
    case "context":
      return "page"
  }
}

function titleFromMeta(meta: ContentMeta): string {
  const explicit = meta.content?.title
  if (explicit) return explicit
  switch (meta.type) {
    case "session":
      return "Session"
    case "draft-session":
      return "New Session"
    case "terminal":
      return "Terminal"
    case "context":
      return "Context"
    case "page":
    case "pages-index":
      return meta.filePath?.split("/").at(-1) || "Page"
    case "workgraph":
      return "WorkGraph"
  }
}

function workspaceDirFromMeta(meta: ContentMeta): string | undefined {
  return meta.directory
}

export function buildSwitcherItemsFromState(state: ClaxedoStateApi): SwitcherItem[] {
  const focusedContentId = state.wb.selectors.focusedContent()
  return state.wb.selectors.aliveContents().flatMap((id) => {
    const meta = state.meta.get(id)
    if (!meta) return []
    return [{
      contentId: id,
      kind: mapKindFromMeta(meta.type),
      title: titleFromMeta(meta),
      workspaceDir: workspaceDirFromMeta(meta),
      active: id === focusedContentId,
    }]
  })
}

function visibleItems(items: SwitcherItem[], max: number, recentContentIds?: readonly string[]) {
  if (items.length <= max) return items
  const selected = new Set<string>()
  const groupIds = new Set(items.map((item) => item.contentId))
  const active = items.find((item) => item.active)
  if (active) selected.add(active.contentId)
  for (const id of recentContentIds ?? []) {
    if (selected.size >= max) break
    if (groupIds.has(id)) selected.add(id)
  }
  for (const item of [...items].reverse()) {
    if (selected.size >= max) break
    selected.add(item.contentId)
  }
  return items.filter((item) => selected.has(item.contentId))
}
