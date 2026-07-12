import { queryClient } from "@/platform/query/query-client"
import { acceptKey } from "./permission-auto-respond"

const MAX_RESPONDED = 1000
const RESPONDED_TTL_MS = 60 * 60 * 1000

type RespondedPermission = {
  at: number
}

export function permissionAutoRespondedQueryKey(permissionID: string) {
  return ["shell", "permission-auto-respond", "responded", permissionID] as const
}

export function permissionAutoAcceptVersionQueryKey(sessionID: string, directory?: string) {
  return ["shell", "permission-auto-respond", "enable-version", acceptKey(sessionID, directory)] as const
}

export function markPermissionAutoResponded(permissionID: string, now = Date.now()) {
  const queryKey = permissionAutoRespondedQueryKey(permissionID)
  const hit = queryClient.getQueryData<RespondedPermission>(queryKey) !== undefined
  queryClient.setQueryData<RespondedPermission>(queryKey, { at: now })
  prunePermissionAutoResponded(now)
  return hit
}

export function clearPermissionAutoResponded(permissionID: string) {
  queryClient.removeQueries({ queryKey: permissionAutoRespondedQueryKey(permissionID), exact: true })
}

export function bumpPermissionAutoAcceptVersion(sessionID: string, directory?: string) {
  const queryKey = permissionAutoAcceptVersionQueryKey(sessionID, directory)
  const next = (queryClient.getQueryData<number>(queryKey) ?? 0) + 1
  queryClient.setQueryData<number>(queryKey, next)
  return next
}

export function permissionAutoAcceptVersion(sessionID: string, directory?: string) {
  return queryClient.getQueryData<number>(permissionAutoAcceptVersionQueryKey(sessionID, directory)) ?? 0
}

export function clearPermissionAutoResponseCache() {
  queryClient.removeQueries({ queryKey: ["shell", "permission-auto-respond"] })
}

function prunePermissionAutoResponded(now: number) {
  const entries = respondedPermissionQueries()

  entries
    .filter((entry) => now - entry.at >= RESPONDED_TTL_MS)
    .forEach((entry) => queryClient.removeQueries({ queryKey: entry.queryKey, exact: true }))

  const fresh = entries
    .filter((entry) => now - entry.at < RESPONDED_TTL_MS)
    .sort((a, b) => a.at - b.at)

  fresh
    .slice(0, Math.max(0, fresh.length - MAX_RESPONDED))
    .forEach((entry) => queryClient.removeQueries({ queryKey: entry.queryKey, exact: true }))
}

function respondedPermissionQueries() {
  return queryClient
    .getQueryCache()
    .findAll({ queryKey: ["shell", "permission-auto-respond", "responded"] })
    .flatMap((query) => {
      if (query.queryKey[0] !== "shell") return []
      if (query.queryKey[1] !== "permission-auto-respond") return []
      if (query.queryKey[2] !== "responded") return []
      if (typeof query.queryKey[3] !== "string") return []
      const at = readRespondedAt(query.state.data)
      if (at === undefined) return []
      return [{ queryKey: query.queryKey, at }]
    })
}

function readRespondedAt(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined
  const at = (input as { at?: unknown }).at
  return typeof at === "number" ? at : undefined
}
