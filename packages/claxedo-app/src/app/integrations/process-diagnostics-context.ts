import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import type { LocalDiagnostics } from "@/features/processes/data/local-diagnostics"
import { parseShellRoute } from "@/platform/identity/route"
import type { ContentMeta } from "@/app/workbench/state/types"
import type { Pane } from "@/app/workbench/workbench"
import type { WorkspacePanelState } from "@/features/workspaces/ui/panel/workspace-panel-state"

export type SessionRenderMetrics = NonNullable<LocalDiagnostics.Context["sessionRender"]>
type SessionRenderMeasurements = Omit<SessionRenderMetrics, "sessionId">

export function buildProcessDiagnosticsContext(input: {
  pathname: string
  activeSessionId?: string
  focusedPaneId?: string
  panes: readonly Pane[]
  contentIds: readonly string[]
  content: (contentId: string) => ContentMeta | undefined
  workspacePanel: WorkspacePanelState
  workspacePanelTab?: string
  sessionRender?: SessionRenderMetrics
}): LocalDiagnostics.Context {
  const route = parseShellRoute(input.pathname)
  const paneContentIds = input.panes.flatMap((pane) => pane.contentId ? [pane.contentId] : [])
  const paneSurfaceTypes = paneContentIds.flatMap((contentId) => {
    const content = input.content(contentId)
    return content ? [content.type] : []
  })
  const terminalTabs = input.contentIds.filter((contentId) => input.content(contentId)?.type === "terminal").length
  const paneBoundTerminals = paneSurfaceTypes.filter((type) => type === "terminal").length
  const focusedContentId = input.focusedPaneId
    ? input.panes.find((pane) => pane.id === input.focusedPaneId)?.contentId
    : undefined
  const focusedSurface = focusedContentId ? input.content(focusedContentId ?? "")?.type : undefined
  const workspaceId = "workspaceId" in route ? route.workspaceId : undefined
  const routeSessionId = "sessionId" in route ? route.sessionId : undefined
  const panel = input.workspacePanel
  return {
    screen: route.kind,
    route: input.pathname,
    ...(workspaceId ? { workspaceId } : {}),
    ...(input.activeSessionId ?? routeSessionId ? { sessionId: input.activeSessionId ?? routeSessionId } : {}),
    workbench: {
      ...(focusedSurface ? { focusedSurface } : {}),
      ...(input.focusedPaneId ? { focusedPaneId: input.focusedPaneId } : {}),
      paneCount: input.panes.length,
      surfaceCount: input.contentIds.length,
      stashedSurfaceCount: Math.max(0, input.contentIds.length - new Set(paneContentIds).size),
      paneSurfaceTypes,
    },
    terminalTabs: {
      total: terminalTabs,
      paneBound: paneBoundTerminals,
      stashed: Math.max(0, terminalTabs - paneBoundTerminals),
    },
    workspacePanel: {
      open: panel.open,
      ...(panel.open && panel.mode ? { mode: panel.mode } : {}),
      ...(panel.open && panel.navigator ? { navigator: panel.navigator } : {}),
      ...(panel.open && panel.mode === "review" && input.workspacePanelTab ? { tab: input.workspacePanelTab } : {}),
      ...(panel.open && panel.focus ? { focus: panel.focus.kind } : {}),
      ...(panel.open ? {
        target: !panel.targetPaneId
          ? "unbound" as const
          : panel.targetPaneId === input.focusedPaneId
            ? "focused-pane" as const
            : "other-pane" as const,
      } : {}),
    },
    ...(input.sessionRender ? { sessionRender: input.sessionRender } : {}),
  }
}

export function useFocusedSessionRenderMetrics(input: {
  enabled: Accessor<boolean>
  paneId: Accessor<string | undefined>
  sessionId: Accessor<string | undefined>
}) {
  const [metrics, setMetrics] = createSignal<SessionRenderMetrics>()

  createEffect(() => {
    setMetrics(undefined)
    if (!input.enabled()) return
    const paneId = input.paneId()
    const sessionId = input.sessionId()
    if (!paneId || !sessionId || typeof document === "undefined") return

    let paneRoot: HTMLElement | undefined
    let observer: MutationObserver | undefined
    let retry: number | undefined
    let sampleTimer: number | undefined
    let idle: number | undefined
    let disposed = false
    let lastSampleAt = Number.NEGATIVE_INFINITY
    let attempts = 0

    const sample = () => {
      sampleTimer = undefined
      idle = undefined
      if (!paneRoot?.isConnected || disposed) return
      const root = findSessionRoot(paneRoot, paneId, sessionId)
      setMetrics(root ? { sessionId, ...readSessionRenderMetrics(root) } : undefined)
      lastSampleAt = Date.now()
    }
    const sampleWhenIdle = () => {
      if (sampleTimer !== undefined || idle !== undefined || disposed) return
      sampleTimer = window.setTimeout(() => {
        sampleTimer = undefined
        const wait = Math.max(0, 5_000 - (Date.now() - lastSampleAt))
        if (wait > 0) {
          sampleTimer = window.setTimeout(sampleWhenIdle, wait)
          return
        }
        const idleWindow = window as Window & {
          requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number
        }
        if (!idleWindow.requestIdleCallback) {
          sample()
          return
        }
        idle = idleWindow.requestIdleCallback(sample, { timeout: 1_000 })
      }, 0)
    }
    const attach = () => {
      retry = undefined
      if (disposed) return
      paneRoot = findPaneRoot(document, paneId)
      if (!paneRoot && attempts++ < 20) {
        retry = window.setTimeout(attach, 500)
        return
      }
      if (!paneRoot) return
      sampleWhenIdle()
      observer = new MutationObserver(sampleWhenIdle)
      observer.observe(paneRoot, {
        attributes: true,
        attributeFilter: [
          "data-session-message-count",
          "data-session-conversation-count",
          "data-session-visible-user-count",
          "data-session-rendered-user-count",
          "data-session-timeline-row-count",
          "data-session-timeline-key-count",
        ],
        childList: true,
        subtree: true,
      })
    }
    attach()

    onCleanup(() => {
      disposed = true
      observer?.disconnect()
      if (retry !== undefined) window.clearTimeout(retry)
      if (sampleTimer !== undefined) window.clearTimeout(sampleTimer)
      if (idle !== undefined) {
        const idleWindow = window as Window & { cancelIdleCallback?: (handle: number) => void }
        idleWindow.cancelIdleCallback?.(idle)
      }
    })
  })

  return metrics
}

export function findSessionRoot(root: ParentNode, paneId: string, sessionId: string) {
  const roots = root instanceof HTMLElement && root.dataset.paneId === paneId
    ? [root]
    : [...root.querySelectorAll<HTMLElement>("[data-pane-id]")]
  return roots
    .filter((element) => element.dataset.paneId === paneId)
    .flatMap((element) => [...element.querySelectorAll<HTMLElement>('[data-testid="session-page-root"]')])
    .find((element) => element.dataset.sessionId === sessionId)
}

export function findPaneRoot(root: ParentNode, paneId: string) {
  return [...root.querySelectorAll<HTMLElement>("[data-workbench-content][data-pane-id]")]
    .find((element) => element.dataset.paneId === paneId)
}

export function readSessionRenderMetrics(root: HTMLElement): SessionRenderMeasurements {
  const timeline = root.querySelector<HTMLElement>("[data-session-timeline-root]")
  return {
    messageCount: count(root.dataset.sessionMessageCount),
    conversationCount: count(root.dataset.sessionConversationCount),
    visibleUserCount: count(root.dataset.sessionVisibleUserCount),
    renderedUserCount: count(root.dataset.sessionRenderedUserCount),
    timelineRowCount: count(timeline?.dataset.sessionTimelineRowCount),
    mountedTimelineRowCount: count(timeline?.dataset.sessionTimelineKeyCount),
    domNodeCount: root.getElementsByTagName("*").length + 1,
  }
}

function count(value: string | undefined) {
  const result = Number.parseInt(value ?? "", 10)
  return Number.isFinite(result) && result >= 0 ? result : 0
}
