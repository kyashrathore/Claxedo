import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
import { useQueries } from "@tanstack/solid-query"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { getFilename } from "@/lib/path"

import { buildSwitcherItemsFromState, type SwitcherStatus } from "../compact-switcher/switcher-items"
import {
  nextUnseenDone,
  sessionSurfaceActive,
  surfaceStatusForMeta,
  type SurfaceSessionRequests,
} from "../compact-switcher/surface-status"
import type { ContentMeta } from "../state/index"
import type { ClaxedoStateApi } from "../state/provider"
import {
  sessionRequestsQueryOptions,
  sessionStatusQueryOptions,
  type SessionRequestsQueryData,
} from "../../../features/session/data/sync/queries"
import { queryClient } from "@/platform/query/query-client"
import { shellDataKeys } from "@/platform/sync/keys"
import type { RailWorktreeInfo } from "./rail-project-session-info"

type HeaderSurfaceClient =
  Parameters<typeof sessionStatusQueryOptions>[0]["client"] &
  Parameters<typeof sessionRequestsQueryOptions>[0]["client"]

export function useRailHeaderSurfaces(input: {
  state: ClaxedoStateApi
  client: HeaderSurfaceClient
  canUseDocuments: Accessor<boolean>
  worktreeInfo: (workspaceDir: string) => RailWorktreeInfo | undefined
  autoResponds: (request: NonNullable<SurfaceSessionRequests["permissions"]>[number], workspaceDir: string) => boolean
  closeTerminal?: (terminalId: string) => void | Promise<unknown>
  onTabSelect?: (meta: ContentMeta) => void
  onTabClose?: (nextActiveTab: ContentMeta | undefined, closedTab: ContentMeta) => void
  onLastFocusedSurfaceClosed?: () => void
}) {
  const headerSessionStatusRefs = createMemo(() =>
    input.state.meta.all()
      .filter((meta) => meta.type === "session" && !!meta.sessionId && meta.sessionId !== "new")
      .map((meta) => ({ contentId: meta.id, sessionId: meta.sessionId! })),
  )
  const headerSessionStatusQueries = useQueries(() => ({
    queries: headerSessionStatusRefs().map((ref) => ({
      ...sessionStatusQueryOptions({
        sessionId: ref.sessionId,
        client: input.client,
      }),
      enabled: false,
    })),
  }))
  const headerSessionRequestQueries = useQueries(() => ({
    queries: headerSessionStatusRefs().map((ref) => ({
      ...sessionRequestsQueryOptions({
        sessionId: ref.sessionId,
        client: input.client,
      }),
      enabled: false,
    })),
  }))
  // `useQueries(..., { enabled: false })` keeps these status/requests cache
  // entries alive (gc protection) but its observer store does NOT reliably
  // re-render off external `setQueryData` writes past the first one — a known
  // solid-query enabled:false + external-write reactivity gap. The status/
  // requests caches are fed entirely by external pushes
  // (`dispatchSessionStatusEvent`), so read them straight from the cache and
  // drive reactivity off an explicit cache subscription instead.
  const [statusCacheEpoch, setStatusCacheEpoch] = createSignal(0)
  onCleanup(queryClient.getQueryCache().subscribe((event) => {
    const key = event.query.queryKey as ReadonlyArray<unknown>
    if (key[0] === "shell" && key[1] === "session" && (key[3] === "status" || key[3] === "requests")) {
      setStatusCacheEpoch((value) => value + 1)
    }
  }))
  const headerSessionStatus = createMemo(() => {
    statusCacheEpoch()
    return new Map(headerSessionStatusRefs().map((ref, index) =>
      [ref.contentId,
        queryClient.getQueryData<SessionStatus>(shellDataKeys.sessionId(ref.sessionId, "status"))
          ?? headerSessionStatusQueries[index]?.data] as const))
  })
  const headerSessionRequests = createMemo(() => {
    statusCacheEpoch()
    return new Map(headerSessionStatusRefs().map((ref, index) =>
      [ref.contentId,
        queryClient.getQueryData<SessionRequestsQueryData>(shellDataKeys.sessionId(ref.sessionId, "requests"))
          ?? headerSessionRequestQueries[index]?.data] as const))
  })
  const [headerSessionUnseenDone, setHeaderSessionUnseenDone] = createSignal<Record<string, true | undefined>>({})
  const headerSessionActive = createMemo(() =>
    new Map(headerSessionStatusRefs().map((ref) => {
      const meta = input.state.meta.get(ref.contentId)
      return [ref.contentId, sessionSurfaceActive({
        statusType: headerSessionStatus().get(ref.contentId)?.type,
        requests: headerSessionRequests().get(ref.contentId),
        directory: meta?.directory,
        autoResponds: input.autoResponds,
      })] as const
    })),
  )

  let previousHeaderSessionActive = new Map<string, boolean>()
  createEffect(() => {
    const active = headerSessionActive()
    const focusedContent = input.state.wb.selectors.focusedContent()
    setHeaderSessionUnseenDone((current) => {
      const next = { ...current }
      let changed = false
      for (const [contentId, isActive] of active) {
        const value = nextUnseenDone({
          active: isActive,
          previousActive: previousHeaderSessionActive.get(contentId),
          focused: focusedContent === contentId,
          current: !!current[contentId],
        })
        if (value) {
          if (!next[contentId]) {
            next[contentId] = true
            changed = true
          }
          continue
        }
        if (next[contentId]) {
          delete next[contentId]
          changed = true
        }
      }
      for (const contentId of Object.keys(next)) {
        if (active.has(contentId)) continue
        delete next[contentId]
        changed = true
      }
      return changed ? next : current
    })
    previousHeaderSessionActive = new Map(active)
  })

  const surfaceStatus = (contentId: string): SwitcherStatus => {
    const meta = input.state.meta.get(contentId)
    return surfaceStatusForMeta({
      meta,
      terminalAgentStatus: meta?.terminalId ? input.state.terminal.agentStatus(meta.terminalId) : undefined,
      terminalSeen: meta?.terminalId ? input.state.terminal.seen(meta.terminalId) : undefined,
      sessionStatusType: headerSessionStatus().get(contentId)?.type,
      sessionRequests: headerSessionRequests().get(contentId),
      sessionUnseenDone: !!headerSessionUnseenDone()[contentId],
      autoResponds: input.autoResponds,
    })
  }
  const switcherItems = createMemo(() =>
    buildSwitcherItemsFromState(input.state, { canUseDocuments: input.canUseDocuments() }).map((item) => {
      const info = item.workspaceDir ? input.worktreeInfo(item.workspaceDir) : undefined
      return {
        ...item,
        status: surfaceStatus(item.contentId),
        projectLabel: info?.projectName,
        projectWorktree: info?.projectWorktree,
        gitRepo: info?.gitRepo,
        gitBranch: info?.gitBranch,
        gitRemote: info?.gitRemote,
        workspaceLabel: item.workspaceDir ? info?.name || getFilename(item.workspaceDir) : "Global",
      }
    })
  )

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
