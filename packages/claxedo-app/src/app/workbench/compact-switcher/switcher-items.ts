import type { ClaxedoStateApi } from "../state/provider"
import type { ContentMeta, ContentType } from "../state/types"
import { resolveSessionTitle } from "@/features/session/lib/session-title-sync"

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
    // Extension views ride the generic document-style tab; a dedicated kind
    // would force a new icon/rendering branch for no behavioral difference.
    case "extension-view":
      return "page"
    default: {
      const exhaustive: never = type
      return exhaustive
    }
  }
}

function titleFromMeta(meta: ContentMeta): string {
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
    case "extension-view":
      return "Extension"
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
  const focusedContentId = state.wb.selectors.focusedContent()
  return buildSwitcherItemsFromStateWithOptions(state, options, focusedContentId)
}

export function buildSwitcherItemsFromStateWithOptions(
  state: ClaxedoStateApi,
  options: SwitcherItemOptions,
  focusedContentId: string | null = state.wb.selectors.focusedContent(),
): SwitcherItem[] {
  return state.wb.selectors.aliveContents().flatMap((id) => {
    const meta = state.meta.get(id)
    if (!meta) return []
    if (options.canUseDocuments !== true && (meta.type === "page" || meta.type === "pages-index")) return []
    return [{
      contentId: id,
      kind: mapKindFromMeta(meta.type),
      title: titleFromMeta(meta),
      workspaceDir: workspaceDirFromMeta(meta),
      active: id === focusedContentId,
      closable: closableFromMeta(meta),
    }]
  })
}
