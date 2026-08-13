// Row time labels and the session-status batch bookkeeping, split from
// rail-sidebar.tsx: standalone helpers with no component state, extracted to
// keep the sidebar under its size-budget ceiling.
import { queryClient } from "@/platform/query/query-client"
import { shellDataKeys } from "@/platform/sync/keys"

export const SIDEBAR_SESSION_STATUS_FRESH_MS = 10_000

export function relativeTime(ts: number) {
  const diff = Date.now() - ts
  const sec = Math.floor(diff / 1000)
  if (sec < 10) return "now"
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d`
  const mo = Math.floor(day / 30)
  if (mo < 12) return `${mo}mo`
  return `${Math.floor(mo / 12)}y`
}

export function sidebarRequestDebug(...args: unknown[]) {
  if (typeof localStorage === "undefined") return
  if (localStorage.getItem("claxedo.debug.sidebar-requests") !== "1") return
  console.debug("[claxedo:sidebar-requests]", ...args)
}

export const sidebarSessionStatusBatches = new Map<string, { updatedAt: number; inFlight?: Promise<void> }>()

export function sameRequestIds(previous: { id: string }[] | undefined, next: { id: string }[]) {
  if (!previous || previous.length !== next.length) return false
  return previous.every((item, index) => item.id === next[index]?.id)
}

export function sidebarStatusTargetFresh(sessionID: string, now = Date.now()) {
  const status = queryClient.getQueryState(shellDataKeys.sessionId(sessionID, "status"))
  const requests = queryClient.getQueryState(shellDataKeys.sessionId(sessionID, "requests"))
  return status?.data !== undefined &&
    requests?.data !== undefined &&
    now - status.dataUpdatedAt < SIDEBAR_SESSION_STATUS_FRESH_MS &&
    now - requests.dataUpdatedAt < SIDEBAR_SESSION_STATUS_FRESH_MS
}

