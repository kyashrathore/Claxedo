import { createComputed, createEffect, createMemo, createSelector, createSignal, mapArray, onCleanup, type Accessor } from "solid-js"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { getFilename } from "@/lib/path"

import {
  buildSwitcherItemsFromStateWithOptions,
  type SwitcherItem,
  type SwitcherStatus,
} from "../compact-switcher/switcher-items"
import {
  nextUnseenDone,
  sessionSurfaceActive,
  surfaceStatusForMeta,
  type SurfaceSessionRequests,
} from "../compact-switcher/surface-status"
import type { ContentMeta } from "../state/index"
import type { ClaxedoStateApi } from "../state/provider"
import type { SessionRequestsQueryData } from "../../../features/session/data/sync/queries"
import { queryClient } from "@/platform/query/query-client"
import { shellDataKeys } from "@/platform/sync/keys"
import type { RailWorktreeInfo } from "./rail-project-session-info"
import { useSessionTitleProjection } from "@/features/session/providers/session-title-projection-provider"
import { subscribeSessionActivity } from "@/features/session/store/session-status-dispatcher"

export function useRailHeaderSurfaces(input: {
  state: ClaxedoStateApi
  canUseDocuments: Accessor<boolean>
  worktreeInfo: (workspaceDir: string) => RailWorktreeInfo | undefined
  autoResponds: (request: NonNullable<SurfaceSessionRequests["permissions"]>[number], workspaceDir: string) => boolean
  closeTerminal?: (terminalId: string) => void | Promise<unknown>
  onTabSelect?: (meta: ContentMeta) => void
  onTabClose?: (nextActiveTab: ContentMeta | undefined, closedTab: ContentMeta) => void
  onLastFocusedSurfaceClosed?: () => void
}) {
  const sessionTitles = useSessionTitleProjection()
  const headerContentIds = createMemo<readonly string[]>((previous) => {
    const next = input.state.wb.selectors.aliveContents().filter((contentId) => {
      const meta = input.state.meta.get(contentId)
      return !!meta && (input.canUseDocuments() || (meta.type !== "page" && meta.type !== "pages-index"))
    })
    return previous?.length === next.length && previous.every((id, index) => id === next[index]) ? previous : next
  })
  const isHeaderContentActive = createSelector<string | null, string>(
    () => input.state.wb.selectors.focusedContent(),
  )
  // Keep one reactive owner per content id. A single array-wide memo made a
  // focus/status/title change rebuild every tab object, so every DOM consumer
  // re-read every title, status, and worktree projection. `mapArray` changes
  // the collection only when membership changes; the property accessors below
  // subscribe each mounted row to its own keyed state.
  const switcherItems = mapArray(headerContentIds, (contentId): SwitcherItem => {
    const meta = () => input.state.meta.get(contentId)
    const sessionId = () => {
      const current = meta()
      return current?.type === "session" && current.sessionId !== "new" ? current.sessionId : undefined
    }
    const [activityRevision, setActivityRevision] = createSignal(0)
    createEffect(() => {
      const id = sessionId()
      if (!id) return
      onCleanup(subscribeSessionActivity(id, () => setActivityRevision((value) => value + 1)))
    })
    const sessionStatus = () => {
      activityRevision()
      const id = sessionId()
      return id ? queryClient.getQueryData<SessionStatus>(shellDataKeys.sessionId(id, "status")) : undefined
    }
    const sessionRequests = () => {
      activityRevision()
      const id = sessionId()
      return id
        ? queryClient.getQueryData<SessionRequestsQueryData>(shellDataKeys.sessionId(id, "requests"))
        : undefined
    }
    const sessionActive = createMemo(() => sessionSurfaceActive({
      statusType: sessionStatus()?.type,
      requests: sessionRequests(),
      directory: meta()?.directory,
      autoResponds: input.autoResponds,
    }))
    const [sessionUnseenDone, setSessionUnseenDone] = createSignal(false)
    let previousSessionActive: boolean | undefined
    createComputed(() => {
      const active = sessionActive()
      setSessionUnseenDone((current) => nextUnseenDone({
        active,
        previousActive: previousSessionActive,
        focused: isHeaderContentActive(contentId),
        current,
      }))
      previousSessionActive = active
    })
    const titleSelection = createMemo(() => {
      const current = meta()
      if (current?.type !== "session" || !current.sessionId) return
      return sessionTitles.select({
        sessionId: current.sessionId,
        ...(current.directory ? { directory: current.directory } : {}),
        ...(current.content?.sessionRef ? { sessionRef: current.content.sessionRef } : {}),
      })
    })
    const status = (): SwitcherStatus => {
      const current = meta()
      return surfaceStatusForMeta({
        meta: current,
        terminalAgentStatus: current?.terminalId
          ? input.state.terminal.agentStatus(current.terminalId)
          : undefined,
        terminalSeen: current?.terminalId ? input.state.terminal.seen(current.terminalId) : undefined,
        sessionStatusType: sessionStatus()?.type,
        sessionRequests: sessionRequests(),
        sessionUnseenDone: sessionUnseenDone(),
        autoResponds: input.autoResponds,
      })
    }
    const base = createMemo(() => buildSwitcherItemsFromStateWithOptions(input.state, {
      canUseDocuments: true,
      sessionTitle: () => titleSelection()?.title(),
      contentIds: [contentId],
      isActive: isHeaderContentActive,
    }, null)[0])
    const info = createMemo(() => {
      const workspaceDir = base()?.workspaceDir
      return workspaceDir ? input.worktreeInfo(workspaceDir) : undefined
    })
    const item = {} as SwitcherItem
    Object.defineProperties(item, {
      contentId: { enumerable: true, get: () => contentId },
      kind: { enumerable: true, get: () => base()!.kind },
      title: { enumerable: true, get: () => base()!.title },
      workspaceDir: { enumerable: true, get: () => base()!.workspaceDir },
      active: { enumerable: true, get: () => isHeaderContentActive(contentId) },
      closable: { enumerable: true, get: () => base()!.closable },
      status: { enumerable: true, get: status },
      projectLabel: { enumerable: true, get: () => info()?.projectName },
      projectWorktree: { enumerable: true, get: () => info()?.projectWorktree },
      gitRepo: { enumerable: true, get: () => info()?.gitRepo },
      gitBranch: { enumerable: true, get: () => info()?.gitBranch },
      gitRemote: { enumerable: true, get: () => info()?.gitRemote },
      workspaceLabel: {
        enumerable: true,
        get: () => {
          const workspaceDir = base()?.workspaceDir
          return workspaceDir ? info()?.name || getFilename(workspaceDir) : "Global"
        },
      },
    })
    return item
  })

  const selectSurface = (contentId: string) => {
    input.state.wb.navigation.show(contentId)
    const meta = input.state.meta.get(contentId)
    if (!meta) return
    input.onTabSelect?.(meta)
  }

  const closeSurface = (contentId: string) => {
    const meta = input.state.meta.get(contentId)
    if (!meta) return
    const wasFocused = input.state.wb.selectors.focusedContent() === contentId
    const items = switcherItems()
    const index = items.findIndex((item) => item.contentId === contentId)
    const nextItem = wasFocused && index >= 0 ? items[index + 1] ?? items[index - 1] : undefined
    const terminalId =
      meta.type === "terminal" && meta.terminalId && !meta.terminalId.startsWith("pending-")
        ? meta.terminalId
        : undefined

    const nextMeta = nextItem ? input.state.meta.get(nextItem.contentId) : undefined
    if (wasFocused && !nextItem) input.onLastFocusedSurfaceClosed?.()
    input.state.layout.closeContent(contentId)
    if (nextItem) {
      input.state.wb.navigation.show(nextItem.contentId)
    }
    if (wasFocused) input.onTabClose?.(nextMeta, meta)
    if (terminalId) void input.closeTerminal?.(terminalId)
  }

  return {
    closeSurface,
    selectSurface,
    switcherItems,
  }
}
