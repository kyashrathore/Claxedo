// Persistence — v5 validator/defaults.

import { constructWorkbenchState, validate as validateWorkbench } from "../workbench/index"
import type { WorkbenchState } from "../workbench/index"
import { createWorkspacePanel, type WorkspacePanelState } from "../../../features/workspaces/ui/panel/workspace-panel-state"
import { CONTENT_TYPES } from "./types"
import type {
  ClaxedoState,
  ContentMeta,
  ContentPayload,
  ContentType,
  ProcessPaneSlice,
  RailSlice,
  TerminalSlice,
  WorkspaceSlice,
} from "./types"

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const obj = (v: unknown): Record<string, unknown> => (isObject(v) ? v : {})
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
const contentTypes = new Set<string>(CONTENT_TYPES)

// ── default factories ─────────────────────────────────────────────────────
function defaultRail(): RailSlice {
  return { collapsed: false, hovered: false, pinned: true, locked: false, width: 260 }
}

function defaultTerminal(): TerminalSlice {
  return { owner: {}, agentStatus: {}, agentSeen: {}, lifecycle: {} }
}

function defaultWorkspace(): WorkspaceSlice {
  return { paneWorktree: {}, recency: {}, worktreeColor: {} }
}

function defaultProcessPane(): ProcessPaneSlice {
  return {
    crashedWhileClosed: false,
    pendingAction: null,
  }
}

export function emptyClaxedoState(): ClaxedoState {
  return {
    workbench: constructWorkbenchState.empty(),
    meta: {},
    rail: defaultRail(),
    workspace: defaultWorkspace(),
    workspacePanel: createWorkspacePanel(),
    terminal: defaultTerminal(),
    processPane: defaultProcessPane(),
  }
}

// ── validation (v5-shape sanity) ──────────────────────────────────────────

const isContentType = (v: unknown): v is ContentType =>
  typeof v === "string" && contentTypes.has(v)

function validateMeta(input: unknown): ContentMeta | undefined {
  if (!isObject(input)) return undefined
  const id = str(input.id)
  if (!id) return undefined
  if (!isContentType(input.type)) return undefined
  const meta: ContentMeta = {
    id,
    type: input.type,
    scope: input.scope === "global" || input.scope === "directory" ? input.scope : undefined,
    directory: str(input.directory),
    draftId: str(input.draftId),
    providerDirectory: str(input.providerDirectory),
    draftPanel: input.draftPanel === "attach" || input.draftPanel === "create" ? input.draftPanel : undefined,
    draftProjectId: str(input.draftProjectId),
    sessionId: str(input.sessionId),
    terminalId: str(input.terminalId),
    filePath: str(input.filePath),
    pageId: str(input.pageId),
    content: isObject(input.content) ? (input.content as ContentPayload) : undefined,
  }
  if (meta.content) {
    meta.directory = meta.directory ?? str(meta.content.directory)
    meta.sessionId = meta.sessionId ?? str(meta.content.sessionId)
    meta.terminalId = meta.terminalId ?? str(meta.content.terminalId)
    meta.filePath = meta.filePath ?? str(meta.content.filePath)
    meta.pageId = meta.pageId ?? str(meta.content.pageId)
  }
  return meta
}

function missingRequiredSessionRef(meta: ContentMeta) {
  const sessionId = meta.sessionId ?? str(meta.content?.sessionId)
  if (!sessionId || sessionId === "new") return false
  if (meta.type !== "session" && meta.type !== "context") return false
  return !meta.content?.sessionRef
}

function validateRail(input: unknown): RailSlice {
  const o = obj(input)
  const width = typeof o.width === "number" && Number.isFinite(o.width) && o.width >= 220 && o.width <= 520
    ? o.width
    : 260
  return {
    collapsed: typeof o.collapsed === "boolean" ? o.collapsed : false,
    hovered: typeof o.hovered === "boolean" ? o.hovered : false,
    pinned: typeof o.pinned === "boolean" ? o.pinned : true,
    locked: typeof o.locked === "boolean" ? o.locked : false,
    width,
  }
}

function validateWorkspace(input: unknown): WorkspaceSlice {
  const o = obj(input)
  const paneWorktree: WorkspaceSlice["paneWorktree"] = {}
  for (const [k, v] of Object.entries(obj(o.paneWorktree))) {
    const e = obj(v)
    paneWorktree[k] = {
      default: typeof e.default === "string" ? e.default : null,
      pinned: typeof e.pinned === "string" ? e.pinned : null,
    }
  }
  const recency: WorkspaceSlice["recency"] = {}
  for (const [k, v] of Object.entries(obj(o.recency))) {
    recency[k] = arr(v).filter((s): s is string => typeof s === "string")
  }
  const worktreeColor: WorkspaceSlice["worktreeColor"] = {}
  for (const [k, v] of Object.entries(obj(o.worktreeColor))) {
    if (typeof v === "string") worktreeColor[k] = v
  }
  return { paneWorktree, recency, worktreeColor }
}

function validateProcessPane(input: unknown): ProcessPaneSlice {
  const o = obj(input)
  const action = o.pendingAction
  return {
    crashedWhileClosed: typeof o.crashedWhileClosed === "boolean" ? o.crashedWhileClosed : false,
    pendingAction:
      action === "startAll" || action === "stopAll" || action === "add" ? action : null,
  }
}

function validateTerminal(input: unknown): TerminalSlice {
  const o = obj(input)
  const owner: TerminalSlice["owner"] = {}
  for (const [k, v] of Object.entries(obj(o.owner))) {
    if (typeof v === "string") owner[k] = v
  }
  const agentStatus: TerminalSlice["agentStatus"] = {}
  for (const [k, v] of Object.entries(obj(o.agentStatus))) {
    if (v === "idle" || v === "working" || v === "permission") agentStatus[k] = v
  }
  const agentSeen: TerminalSlice["agentSeen"] = {}
  for (const [k, v] of Object.entries(obj(o.agentSeen))) {
    if (v === true) agentSeen[k] = true
  }
  const lifecycle: TerminalSlice["lifecycle"] = {}
  for (const [k, v] of Object.entries(obj(o.lifecycle))) {
    if (
      v === "creating" ||
      v === "attaching" ||
      v === "attached" ||
      v === "closing" ||
      v === "closed"
    ) {
      lifecycle[k] = v
    }
  }
  return { owner, agentStatus, agentSeen, lifecycle }
}

function validateWorkspacePanel(input: unknown): WorkspacePanelState {
  if (!isObject(input)) return createWorkspacePanel()
  // Trust the shape — the existing pure helpers consume this directly. The
  // only enforced invariant is the boolean `open`.
  if (typeof (input as WorkspacePanelState).open !== "boolean") {
    return createWorkspacePanel()
  }
  return input as WorkspacePanelState
}

/**
 * Normalize an unknown blob to a fully-formed ClaxedoState. Always returns a
 * usable state — drops invalid fragments and back-fills defaults.
 */
export function validate(input: unknown): { state: ClaxedoState; dirty: boolean } {
  if (!isObject(input)) {
    return { state: emptyClaxedoState(), dirty: true }
  }
  let dirty = false

  // Workbench
  const wbResult = validateWorkbench(input.workbench)
  if (wbResult.dirty) dirty = true
  const metaIn = obj(input.meta)
  const deprecatedContentIds = new Set(
    Object.entries(metaIn)
      .filter(([, raw]) => isObject(raw) && raw.type === "process")
      .map(([id]) => id),
  )
  let workbench: WorkbenchState =
    deprecatedContentIds.size === 0
      ? wbResult.state
      : {
          ...wbResult.state,
          panes: wbResult.state.panes.map((pane) =>
            pane.contentId && deprecatedContentIds.has(pane.contentId)
              ? { ...pane, contentId: null }
              : pane,
          ),
          contentIds: wbResult.state.contentIds.filter((id) => !deprecatedContentIds.has(id)),
          contentRecency: wbResult.state.contentRecency.filter((id) => !deprecatedContentIds.has(id)),
          layoutSnapshots: Object.fromEntries(
            Object.entries(wbResult.state.layoutSnapshots).filter(([id]) => !deprecatedContentIds.has(id)),
          ),
        }
  if (deprecatedContentIds.size > 0) dirty = true

  // Meta — drop entries whose id is not in workbench.contentIds. The
  // workbench is the source of truth for which contents are alive.
  const aliveIds = new Set(workbench.contentIds)
  const meta: Record<string, ContentMeta> = {}
  for (const [id, raw] of Object.entries(metaIn)) {
    const m = validateMeta(raw)
    if (!m) {
      dirty = true
      continue
    }
    if (!aliveIds.has(id)) {
      dirty = true
      continue
    }
    if (missingRequiredSessionRef(m)) {
      dirty = true
      continue
    }
    const metaEntry = m
    if (metaEntry.id !== id) {
      // Id mismatch — favour the map key.
      meta[id] = { ...metaEntry, id }
      dirty = true
      continue
    }
    meta[id] = metaEntry
  }
  // Workbench content without metadata cannot render: ContentRenderer dispatches
  // entirely from the metadata registry. Drop those stale ids so route intent
  // can create a real surface instead of leaving an empty mounted pane.
  const missingMetaIds = new Set(workbench.contentIds.filter((id) => !meta[id]))
  if (missingMetaIds.size > 0) {
    const cleaned = validateWorkbench({
      ...workbench,
      panes: workbench.panes.map((pane) =>
        pane.contentId && missingMetaIds.has(pane.contentId)
          ? { ...pane, contentId: null }
          : pane,
      ),
      contentIds: workbench.contentIds.filter((id) => !missingMetaIds.has(id)),
      contentRecency: workbench.contentRecency.filter((id) => !missingMetaIds.has(id)),
      layoutSnapshots: Object.fromEntries(
        Object.entries(workbench.layoutSnapshots).filter(([id]) => !missingMetaIds.has(id)),
      ),
    })
    workbench = cleaned.state
    dirty = true
    if (cleaned.dirty) dirty = true
  }

  const rail = validateRail(input.rail)
  const workspace = validateWorkspace(input.workspace)
  const workspacePanel = validateWorkspacePanel(input.workspacePanel)
  const terminal = validateTerminal(input.terminal)
  const processPane = validateProcessPane(input.processPane)

  return {
    state: { workbench, meta, rail, workspace, workspacePanel, terminal, processPane },
    dirty,
  }
}
