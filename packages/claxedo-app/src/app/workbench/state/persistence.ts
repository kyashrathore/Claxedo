// Persistence — v5 validator/defaults.

import { asRecordOrEmpty, asString, isRecord } from "@claxedo/helpers/guards"
import { constructWorkbenchState, validate as validateWorkbench } from "../workbench/index"
import type { WorkbenchState } from "../workbench/index"
import {
  createWorkspacePanel,
  type FileFocusIntent,
  type WorkspacePanelMode,
  type WorkspacePanelNavigator,
  type WorkspacePanelState,
} from "../../../features/workspaces/ui/panel/workspace-panel-state"
import { CONTENT_TYPES, PINNED_CONTENT_TYPES } from "./types"
import { selectEvictableSurfaces } from "./surface-budget"
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

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
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

/**
 * The persisted payload of one content entry, read against the arm its
 * `ContentMeta.type` names.
 *
 * Each arm of `ContentPayload` guarantees fields the surface that renders it
 * dereferences — a "page" has a `pageId`, a "draft-session" has a `draftId` and
 * a `providerDirectory`, a scoped surface has a `directory`. Those are checked;
 * the rest of the blob (title, intent, sessionRef, …) is carried through
 * untouched, so nothing a writer stored is dropped on the way back in. The
 * payload's own `type` is ignored in favour of the entry's, which
 * `validateMeta` has already checked — they are the same discriminant, and a
 * blob where they disagree is the entry's to name.
 */
function validateContentPayload(input: unknown, type: ContentType): ContentPayload | undefined {
  if (!isRecord(input)) return undefined
  if (type === "page") {
    const pageId = asString(input.pageId)
    return pageId === undefined ? undefined : { ...input, type, pageId }
  }
  if (type === "pages-index" || type === "marketplace" || type === "tasks") return { ...input, type }
  if (type === "draft-session") {
    const draftId = asString(input.draftId)
    const providerDirectory = asString(input.providerDirectory)
    return draftId === undefined || providerDirectory === undefined
      ? undefined
      : { ...input, type, draftId, providerDirectory }
  }
  if (type === "session") {
    const sessionId = asString(input.sessionId)
    return sessionId === undefined ? undefined : { ...input, type, sessionId }
  }
  const directory = asString(input.directory)
  return directory === undefined ? undefined : { ...input, type, directory }
}

function validateMeta(input: unknown): ContentMeta | undefined {
  if (!isRecord(input)) return undefined
  const id = asString(input.id)
  if (!id) return undefined
  if (!isContentType(input.type)) return undefined
  const meta: ContentMeta = {
    id,
    type: input.type,
    scope: input.scope === "global" || input.scope === "directory" ? input.scope : undefined,
    directory: asString(input.directory),
    draftId: asString(input.draftId),
    providerDirectory: asString(input.providerDirectory),
    draftPanel: input.draftPanel === "attach" || input.draftPanel === "create" ? input.draftPanel : undefined,
    draftProjectId: asString(input.draftProjectId),
    sessionId: asString(input.sessionId),
    terminalId: asString(input.terminalId),
    filePath: asString(input.filePath),
    pageId: asString(input.pageId),
    content: validateContentPayload(input.content, input.type),
  }
  if (meta.content) {
    meta.directory = meta.directory ?? asString(meta.content.directory)
    meta.sessionId = meta.sessionId ?? asString(meta.content.sessionId)
    meta.terminalId = meta.terminalId ?? asString(meta.content.terminalId)
    meta.filePath = meta.filePath ?? asString(meta.content.filePath)
    meta.pageId = meta.pageId ?? asString(meta.content.pageId)
  }
  return meta
}

function missingRequiredSessionRef(meta: ContentMeta) {
  const sessionId = meta.sessionId ?? asString(meta.content?.sessionId)
  if (!sessionId || sessionId === "new") return false
  if (meta.type !== "session" && meta.type !== "context") return false
  return !meta.content?.sessionRef
}

function validateRail(input: unknown): RailSlice {
  const o = asRecordOrEmpty(input)
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
  const o = asRecordOrEmpty(input)
  const paneWorktree: WorkspaceSlice["paneWorktree"] = {}
  for (const [k, v] of Object.entries(asRecordOrEmpty(o.paneWorktree))) {
    const e = asRecordOrEmpty(v)
    paneWorktree[k] = {
      default: typeof e.default === "string" ? e.default : null,
      pinned: typeof e.pinned === "string" ? e.pinned : null,
    }
  }
  const recency: WorkspaceSlice["recency"] = {}
  for (const [k, v] of Object.entries(asRecordOrEmpty(o.recency))) {
    recency[k] = arr(v).filter((s): s is string => typeof s === "string")
  }
  const worktreeColor: WorkspaceSlice["worktreeColor"] = {}
  for (const [k, v] of Object.entries(asRecordOrEmpty(o.worktreeColor))) {
    if (typeof v === "string") worktreeColor[k] = v
  }
  return { paneWorktree, recency, worktreeColor }
}

function validateProcessPane(input: unknown): ProcessPaneSlice {
  const o = asRecordOrEmpty(input)
  const action = o.pendingAction
  return {
    crashedWhileClosed: typeof o.crashedWhileClosed === "boolean" ? o.crashedWhileClosed : false,
    pendingAction:
      action === "startAll" || action === "stopAll" || action === "add" ? action : null,
  }
}

function validateTerminal(input: unknown): TerminalSlice {
  const o = asRecordOrEmpty(input)
  const owner: TerminalSlice["owner"] = {}
  for (const [k, v] of Object.entries(asRecordOrEmpty(o.owner))) {
    if (typeof v === "string") owner[k] = v
  }
  const agentStatus: TerminalSlice["agentStatus"] = {}
  for (const [k, v] of Object.entries(asRecordOrEmpty(o.agentStatus))) {
    if (v === "idle" || v === "working" || v === "permission") agentStatus[k] = v
  }
  const agentSeen: TerminalSlice["agentSeen"] = {}
  for (const [k, v] of Object.entries(asRecordOrEmpty(o.agentSeen))) {
    if (v === true) agentSeen[k] = true
  }
  const lifecycle: TerminalSlice["lifecycle"] = {}
  for (const [k, v] of Object.entries(asRecordOrEmpty(o.lifecycle))) {
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

const isWorkspacePanelMode = (v: unknown): v is WorkspacePanelMode =>
  v === "files" || v === "review" || v === "processes" || v === "activity"
const isWorkspacePanelNavigator = (v: unknown): v is WorkspacePanelNavigator =>
  v === "files" || v === "changes" || v === "processes"
const isFileFocusIntent = (v: unknown): v is FileFocusIntent =>
  v === "tab" || v === "review"

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined

/**
 * A persisted focus target, read arm by arm.
 *
 * The panel body branches on `kind` and then reads that arm's own fields, so a
 * blob whose arm is incomplete (a "file" focus with no `path`, a focus with no
 * `version` to compare against) has no arm to be — it is dropped rather than
 * admitted as one.
 */
function validateWorkspacePanelFocus(input: unknown): WorkspacePanelState["focus"] {
  if (!isRecord(input)) return undefined
  const version = num(input.version)
  if (version === undefined) return undefined
  if (input.kind === "review") return { kind: "review", version }
  if (input.kind === "browser") {
    const url = asString(input.url)
    return url === undefined ? undefined : { kind: "browser", url, version }
  }
  if (input.kind === "process") {
    const processId = asString(input.processId)
    return processId === undefined ? undefined : { kind: "process", processId, version }
  }
  if (input.kind === "subagent") {
    const sessionId = asString(input.sessionId)
    if (sessionId === undefined) return undefined
    const label = asString(input.label)
    const description = asString(input.description)
    return {
      kind: "subagent",
      sessionId,
      ...(label === undefined ? {} : { label }),
      ...(description === undefined ? {} : { description }),
      version,
    }
  }
  if (input.kind === "context") {
    const sessionId = asString(input.sessionId)
    return sessionId === undefined ? undefined : { kind: "context", sessionId, version }
  }
  if (input.kind !== "file") return undefined
  const path = asString(input.path)
  const intent = input.intent
  if (path === undefined || !isFileFocusIntent(intent)) return undefined
  const line = num(input.line)
  const col = num(input.col)
  return {
    kind: "file",
    path,
    version,
    intent,
    ...(line === undefined ? {} : { line }),
    ...(col === undefined ? {} : { col }),
  }
}

function validateWorkspacePanelActivity(input: unknown): WorkspacePanelState["activitySubject"] {
  if (!isRecord(input)) return undefined
  const subjectType = asString(input.subjectType)
  const subjectId = asString(input.subjectId)
  if (subjectType === undefined || subjectId === undefined) return undefined
  const label = asString(input.label)
  return { subjectType, subjectId, ...(label === undefined ? {} : { label }) }
}

/**
 * The persisted panel blob, read field by field.
 *
 * Every field here is a closed literal union or a primitive the panel body
 * branches on, so all of them are checkable — `open` was only ever the first of
 * them, and admitting the rest unchecked let a stale blob put the panel in a
 * mode no component renders.
 */
function validateWorkspacePanel(input: unknown): WorkspacePanelState {
  if (!isRecord(input) || typeof input.open !== "boolean") return createWorkspacePanel()
  const workspaceDir = asString(input.workspaceDir)
  const targetPaneId = asString(input.targetPaneId)
  const focus = validateWorkspacePanelFocus(input.focus)
  const activitySubject = validateWorkspacePanelActivity(input.activitySubject)
  return {
    open: input.open,
    ...(isWorkspacePanelMode(input.mode) ? { mode: input.mode } : {}),
    ...(workspaceDir === undefined ? {} : { workspaceDir }),
    ...(targetPaneId === undefined ? {} : { targetPaneId }),
    ...(isWorkspacePanelNavigator(input.navigator) ? { navigator: input.navigator } : {}),
    ...(typeof input.navigatorHidden === "boolean" ? { navigatorHidden: input.navigatorHidden } : {}),
    ...(focus === undefined ? {} : { focus }),
    ...(activitySubject === undefined ? {} : { activitySubject }),
  }
}

/**
 * Remove a set of contents from a workbench state — unassign their panes, drop
 * them from `contentIds`/`contentRecency`, and discard their layout snapshots.
 */
function dropContents(state: WorkbenchState, drop: ReadonlySet<string>): WorkbenchState {
  if (drop.size === 0) return state
  return {
    ...state,
    panes: state.panes.map((pane) =>
      pane.contentId && drop.has(pane.contentId) ? { ...pane, contentId: null } : pane,
    ),
    contentIds: state.contentIds.filter((id) => !drop.has(id)),
    contentRecency: state.contentRecency.filter((id) => !drop.has(id)),
    layoutSnapshots: Object.fromEntries(
      Object.entries(state.layoutSnapshots).filter(([id]) => !drop.has(id)),
    ),
  }
}

/**
 * Normalize an unknown blob to a fully-formed ClaxedoState. Always returns a
 * usable state — drops invalid fragments and back-fills defaults.
 */
export function validate(input: unknown): { state: ClaxedoState; dirty: boolean } {
  if (!isRecord(input)) {
    return { state: emptyClaxedoState(), dirty: true }
  }
  let dirty = false

  // Workbench
  const wbResult = validateWorkbench(input.workbench)
  if (wbResult.dirty) dirty = true
  const metaIn = asRecordOrEmpty(input.meta)
  // Contents that do not survive a relaunch: the retired process surface, and
  // the marketplace, which is a place you go rather than work you left open —
  // restoring it made the store the app's landing page and its slow signed
  // reads the first thing every launch waited on.
  const deprecatedContentIds = new Set(
    Object.entries(metaIn)
      .filter(([, raw]) => isRecord(raw) && (raw.type === "process" || raw.type === "marketplace"))
      .map(([id]) => id),
  )
  let workbench: WorkbenchState = dropContents(wbResult.state, deprecatedContentIds)
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
    const cleaned = validateWorkbench(dropContents(workbench, missingMetaIds))
    workbench = cleaned.state
    dirty = true
    if (cleaned.dirty) dirty = true
  }

  // Apply the LRU surface budget to what survived. Nothing else reaps tabs, so
  // without this a long-lived profile accumulates every session and terminal it
  // ever opened — the persisted blob only ever grows, and tabs whose backing
  // session is long gone stay in the switcher forever. Runs last so that junk
  // dropped above never costs a live tab its slot.
  const evictedIds = new Set(
    selectEvictableSurfaces({
      contentIds: workbench.contentIds,
      contentRecency: workbench.contentRecency,
      mountedIds: workbench.panes
        .map((pane) => pane.contentId)
        .filter((id): id is string => !!id),
      pinnedIds: workbench.contentIds.filter((id) => {
        const type = meta[id]?.type
        return !!type && PINNED_CONTENT_TYPES.has(type)
      }),
    }),
  )
  if (evictedIds.size > 0) {
    const trimmed = validateWorkbench(dropContents(workbench, evictedIds))
    workbench = trimmed.state
    dirty = true
    for (const id of evictedIds) delete meta[id]
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
