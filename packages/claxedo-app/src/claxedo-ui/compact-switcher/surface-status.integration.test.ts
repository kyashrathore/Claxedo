// End-to-end integration for the consolidated agent-status seam.
//
// Before consolidation the compact header strip (rail-layout) and the sidebar
// (rail-sidebar) each computed surface status from their own copy of the logic
// (`surface-status.ts` vs the deleted `rail-sidebar-session-status.ts`, plus an
// inline terminal reducer). They could silently drift. Now BOTH surfaces feed a
// single module, so the same underlying session/terminal state must produce the
// same badge on both surfaces.
//
// This test drives the REAL pipeline:
//   real ClaxedoState mutation
//     -> buildSwitcherItemsFromState (the real item builder)
//       -> surfaceStatusForMeta (the real header dispatch, reading the real
//          terminal store + session query data)
// and asserts, across the full status matrix, that:
//   (1) the badge value is correct, and
//   (2) the header badge equals the sidebar badge for the same logical state,
//       even though the header sources status as a SessionStatus object and the
//       sidebar sources it as a plain runtime string.

import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import type { PermissionRequest, QuestionRequest, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { reducers, selectors as pureSelectors, validate as validateWb } from "../layout"
import type { UseWorkbench, WorkbenchState } from "../layout"
import { emptyClaxedoState } from "../state/persistence"
import { createMetadataSlice } from "../state/metadata"
import { createTerminalSlice } from "../state/terminal"
import { createWorkspaceSlice } from "../state/workspace"
import { createRailSlice } from "../state/rail"
import { createWorkspacePanelSlice } from "../state/workspace-panel"
import { createProcessPaneSlice } from "../state/process-pane"
import { createLayoutOrchestration } from "../state/orchestration"
import type { ClaxedoState } from "../state/types"
import type { ClaxedoStateApi } from "../state/provider"
import { buildSwitcherItemsFromState } from "./switcher-items"
import type { SwitcherStatus } from "./switcher-items"
import {
  nextUnseenDone,
  sessionSurfaceStatus,
  surfaceStatusForMeta,
  terminalSurfaceStatus,
  type SurfaceSessionRequests,
} from "./surface-status"

function fakeWb(initial: WorkbenchState): UseWorkbench {
  let state = initial
  const apply = (mut: (s: WorkbenchState) => WorkbenchState) => {
    state = mut(state)
  }
  return {
    get state() {
      return state
    },
    contents: {
      add: (id) => apply((s) => reducers.contents.add(s, id)),
      remove: (id) => apply((s) => reducers.contents.remove(s, id)),
    },
    panes: { assign: (paneId, contentId) => apply((s) => reducers.panes.assign(s, paneId, contentId)) },
    split: {
      split: (t, e, c) => apply((s) => reducers.split.split(s, t, e, c)),
      close: (p, o) => apply((s) => reducers.split.close(s, p, o ?? { destroyContent: false })),
      move: (c, f, t) => apply((s) => reducers.split.move(s, c, f, t)),
      focus: (p) => apply((s) => reducers.split.focus(s, p)),
      resize: (p, r) => apply((s) => reducers.split.resize(s, p, r)),
    },
    navigation: { show: (c) => apply((s) => reducers.navigation.show(s, c)) },
    selectors: {
      aliveContents: () => pureSelectors.aliveContents(state),
      recentContents: () => pureSelectors.recentContents(state),
      contentPane: (id) => pureSelectors.contentPane(state, id),
      visiblePanes: () => pureSelectors.visiblePanes(state),
      paneRect: (id) => pureSelectors.paneRect(state, id),
      focusedContent: () => pureSelectors.focusedContent(state),
      snapshotFor: (id) => pureSelectors.snapshotFor(state, id),
    },
  }
}

function makeApi(): ClaxedoStateApi {
  const [state, setState] = createStore<ClaxedoState>(emptyClaxedoState())
  const wb = fakeWb(validateWb(state.workbench).state)
  const meta = createMetadataSlice({ state, setState })
  const terminal = createTerminalSlice({ state, setState })
  const workspace = createWorkspaceSlice({ state, setState })
  const rail = createRailSlice({ state, setState })
  const processPane = createProcessPaneSlice({ state, setState })
  const workspacePanel = createWorkspacePanelSlice({
    state,
    setState,
    defaultTarget: () => ({ workspaceDir: undefined, targetPaneId: undefined }),
  })
  const layout = createLayoutOrchestration({ wb, meta, terminal })
  return { wb, meta, terminal, workspace, rail, workspacePanel, processPane, layout, ready: () => true, state }
}

const WS = "/work/foo"

const permission = (id: string, sessionID: string): PermissionRequest => ({
  id,
  sessionID,
  tool: "bash",
  title: "Run command",
  metadata: {},
  permission: "edit",
  time: { created: 1 },
})

const question = (id: string, sessionID: string): QuestionRequest => ({
  id,
  sessionID,
  title: "Choose an option",
  options: [],
  time: { created: 1 },
})

// One logical session state, expressed both ways the two surfaces source it.
type SessionCase = {
  name: string
  statusType: string // header reads SessionStatus.type; sidebar reads the runtime string
  requests?: SurfaceSessionRequests
  unseenDone?: boolean
  autoRespondsAll?: boolean
  expected: SwitcherStatus
}

const SESSION_CASES: SessionCase[] = [
  { name: "idle, no requests", statusType: "idle", expected: "idle" },
  { name: "busy", statusType: "busy", expected: "working" },
  { name: "retry", statusType: "retry", expected: "working" },
  {
    name: "busy + blocking permission",
    statusType: "busy",
    requests: { permissions: [permission("p1", "ses_chat")], questions: [] },
    expected: "permission",
  },
  {
    name: "idle + pending question",
    statusType: "idle",
    requests: { permissions: [], questions: [question("q1", "ses_chat")] },
    expected: "permission",
  },
  {
    name: "busy + auto-responded permission (ignored)",
    statusType: "busy",
    requests: { permissions: [permission("pa", "ses_chat")], questions: [] },
    autoRespondsAll: true,
    expected: "working",
  },
  { name: "idle + unseen-done", statusType: "idle", unseenDone: true, expected: "done" },
]

type TerminalCase = {
  name: string
  apply: (api: ClaxedoStateApi, terminalId: string) => void
  expected: SwitcherStatus
}

const TERMINAL_CASES: TerminalCase[] = [
  { name: "working", apply: (api, id) => api.terminal.setAgentStatus(id, "working"), expected: "working" },
  { name: "permission", apply: (api, id) => api.terminal.setAgentStatus(id, "permission"), expected: "permission" },
  {
    name: "idle + seen -> done",
    apply: (api, id) => {
      api.terminal.setAgentStatus(id, "working") // marks seen
      api.terminal.setAgentStatus(id, "idle") // settles, seen stays
    },
    expected: "done",
  },
  { name: "fresh idle, unseen", apply: () => {}, expected: "idle" },
]

describe("agent-status seam — end to end (single source, both surfaces agree)", () => {
  for (const c of SESSION_CASES) {
    test(`session: ${c.name}`, () => {
      const api = makeApi()
      const contentId = api.layout.openSession(WS, "ses_chat", "Alpha")

      const autoResponds = c.autoRespondsAll ? () => true : () => false

      // ── HEADER path: drive the REAL item builder + REAL dispatch, sourcing
      // session status the way rail-layout does (a SessionStatus object). ──
      const headerStatusObject: SessionStatus = { type: c.statusType } as SessionStatus
      const headerStatusByContent = new Map<string, SessionStatus>([[contentId, headerStatusObject]])
      const headerRequestsByContent = new Map<string, SurfaceSessionRequests | undefined>([[contentId, c.requests]])
      const headerUnseenDone: Record<string, true | undefined> = c.unseenDone ? { [contentId]: true } : {}

      const items = buildSwitcherItemsFromState(api).map((item) => ({
        ...item,
        status: surfaceStatusForMeta({
          meta: api.meta.get(item.contentId),
          terminalAgentStatus: undefined,
          terminalSeen: undefined,
          sessionStatusType: headerStatusByContent.get(item.contentId)?.type,
          sessionRequests: headerRequestsByContent.get(item.contentId),
          sessionUnseenDone: !!headerUnseenDone[item.contentId],
          autoResponds,
        }),
      }))

      const headerItem = items.find((i) => i.contentId === contentId)!
      expect(headerItem.status).toBe(c.expected)

      // ── SIDEBAR path: same logical state, sourced the way rail-sidebar does
      // (a plain runtime status string). ──
      const sidebarStatus = sessionSurfaceStatus({
        statusType: c.statusType,
        requests: c.requests,
        directory: WS,
        unseenDone: c.unseenDone,
        autoResponds,
      })
      expect(sidebarStatus).toBe(c.expected)

      // ── PARITY: the consolidation guarantee. ──
      expect(headerItem.status).toBe(sidebarStatus)
    })
  }

  for (const c of TERMINAL_CASES) {
    test(`terminal: ${c.name}`, () => {
      const api = makeApi()
      const contentId = api.layout.openTerminal(WS, "term_1", "Dev server")
      const meta = api.meta.get(contentId)!
      c.apply(api, meta.terminalId!)

      // HEADER path through the real dispatch + real terminal store.
      const items = buildSwitcherItemsFromState(api).map((item) => ({
        ...item,
        status: surfaceStatusForMeta({
          meta: api.meta.get(item.contentId),
          terminalAgentStatus: api.meta.get(item.contentId)?.terminalId
            ? api.terminal.agentStatus(api.meta.get(item.contentId)!.terminalId!)
            : undefined,
          terminalSeen: api.meta.get(item.contentId)?.terminalId
            ? api.terminal.seen(api.meta.get(item.contentId)!.terminalId!)
            : undefined,
        }),
      }))
      const headerItem = items.find((i) => i.contentId === contentId)!
      expect(headerItem.status).toBe(c.expected)

      // SIDEBAR path: rail-sidebar's terminalStatus uses the same shared reducer.
      const sidebarStatus = terminalSurfaceStatus({
        status: api.terminal.agentStatus(meta.terminalId!),
        seen: api.terminal.seen(meta.terminalId!),
      })
      expect(sidebarStatus).toBe(c.expected)
      expect(headerItem.status).toBe(sidebarStatus)
    })
  }

  test("unseen-done lifecycle: active -> settled unfocused shows done on both surfaces", () => {
    const api = makeApi()
    const contentId = api.layout.openSession(WS, "ses_chat", "Alpha")
    // Some other surface is focused, so this session is unfocused.
    const other = api.layout.openSession(WS, "ses_other", "Bravo")
    api.wb.navigation.show(other)

    // Tick 1: session is busy (active).
    const activeNow = sessionSurfaceStatus({ statusType: "busy" }) !== "idle"
    expect(activeNow).toBe(true)
    const wasActive = true

    // Tick 2: session settles to idle while unfocused -> becomes unseen-done.
    const unseen = nextUnseenDone({
      active: false,
      previousActive: wasActive,
      focused: false,
      current: false,
    })
    expect(unseen).toBe(true)

    // Both surfaces render "done" from the one module for the settled session.
    const headerDone = surfaceStatusForMeta({
      meta: api.meta.get(contentId),
      sessionStatusType: "idle",
      sessionUnseenDone: unseen,
    })
    const sidebarDone = sessionSurfaceStatus({ statusType: "idle", unseenDone: unseen })
    expect(headerDone).toBe("done")
    expect(sidebarDone).toBe("done")
    expect(headerDone).toBe(sidebarDone)

    // Focusing it clears the unseen-done (no stale "done" badge).
    const clearedOnFocus = nextUnseenDone({
      active: false,
      previousActive: wasActive,
      focused: true,
      current: true,
    })
    expect(clearedOnFocus).toBe(false)
    expect(sessionSurfaceStatus({ statusType: "idle", unseenDone: clearedOnFocus })).toBe("idle")
  })
})
