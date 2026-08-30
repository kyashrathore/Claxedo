import type { ClaxedoStateApi } from "../state/provider"
import type { ContentMeta, ContentType } from "../state/types"
import { resolveSessionTitle } from "@/features/session/lib/session-title-sync"
import type { SessionTitleTarget } from "@/features/session/store/session-title-projection"

export type SwitcherStatus = "idle" | "working" | "permission" | "done"
export type SwitcherKind = "session" | "terminal" | "page" | "marketplace" | "workgraph"

export type SwitcherItem = {
  contentId: string
  kind: SwitcherKind
  title: string
  workspaceDir?: string
  projectLabel?: string
  projectWorktree?: string
  gitRepo?: string
  gitBranch?: string
  gitRemote?: string
  workspaceLabel?: string
  active: boolean
  closable?: boolean
  status?: SwitcherStatus
}

export type SwitcherItemOptions = {
  canUseDocuments?: boolean
  sessionTitle?: (target: SessionTitleTarget) => string | undefined
  contentIds?: readonly string[]
  isActive?: (contentId: string) => boolean
}

/** All SwitcherKind values mapKindFromMeta can ever return, for parity testing against ContentType. */
export const SWITCHER_KINDS = ["session", "terminal", "page", "marketplace", "workgraph"] as const satisfies readonly SwitcherKind[]

export function mapKindFromMeta(type: ContentType): SwitcherKind {
  switch (type) {
    case "session":
    case "draft-session":
      return "session"
    case "terminal":
      return "terminal"
    case "page":
    case "pages-index":
      return "page"
    case "marketplace":
      return "marketplace"
    case "workgraph":
    case "workspace-workgraph":
      return "workgraph"
    case "task-composer":
      return "session"
    case "context":
      return "page"
    default: {
      const exhaustive: never = type
      return exhaustive
    }
  }
}

function titleFromMeta(meta: ContentMeta, options: SwitcherItemOptions): string {
  const projected = meta.type === "session" && meta.sessionId
    ? options.sessionTitle?.({
      sessionId: meta.sessionId,
      ...(meta.directory ? { directory: meta.directory } : {}),
      ...(meta.content?.sessionRef ? { sessionRef: meta.content.sessionRef } : {}),
    })
    : undefined
  if (projected) return projected
  const explicit = meta.type === "session" || meta.type === "draft-session"
    ? resolveSessionTitle({ provisionalTitle: meta.content?.title })
    : meta.content?.title
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
      return meta.filePath?.split("/").at(-1) || "Document"
    case "marketplace":
      return "Marketplace"
    case "workgraph":
      return "WorkGraph"
    case "workspace-workgraph":
      return "Project WorkGraph"
    case "task-composer":
      return "New task"
    default: {
      const exhaustive: never = meta.type
      return exhaustive
    }
  }
}

function workspaceDirFromMeta(meta: ContentMeta): string | undefined {
  return meta.directory
}

function closableFromMeta(meta: ContentMeta): boolean {
  return meta.type !== "pages-index"
}

export function buildSwitcherItemsFromState(state: ClaxedoStateApi, options: SwitcherItemOptions = {}): SwitcherItem[] {
  const focusedContentId = options.isActive ? null : state.wb.selectors.focusedContent()
  return buildSwitcherItemsFromStateWithOptions(state, options, focusedContentId)
}

export function buildSwitcherItemsFromStateWithOptions(
  state: ClaxedoStateApi,
  options: SwitcherItemOptions,
  focusedContentId: string | null = state.wb.selectors.focusedContent(),
): SwitcherItem[] {
  return (options.contentIds ?? state.wb.selectors.aliveContents()).flatMap((id) => {
    const meta = state.meta.get(id)
    if (!meta) return []
    if (options.canUseDocuments !== true && (meta.type === "page" || meta.type === "pages-index")) return []
    const item: SwitcherItem = {
      contentId: id,
      kind: mapKindFromMeta(meta.type),
      title: titleFromMeta(meta, options),
      workspaceDir: workspaceDirFromMeta(meta),
      active: false,
      closable: closableFromMeta(meta),
    }
    if (options.isActive) {
      Object.defineProperty(item, "active", {
        // Keep the accessor lazy through intermediate object projection. A
        // spread would otherwise read every key and subscribe one memo to all
        // tabs, restoring the full-list focus fanout this selector removes.
        enumerable: false,
        configurable: true,
        get: () => options.isActive!(id),
      })
    } else {
      item.active = id === focusedContentId
    }
    return [item]
  })
}
