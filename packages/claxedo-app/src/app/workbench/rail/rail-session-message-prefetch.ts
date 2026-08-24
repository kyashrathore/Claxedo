import { normalizeMessageRows } from "@/features/session/store/message-page"
import {
  fetchSessionMessagesByTransport,
  type SessionClient,
} from "@/features/session/store/session-transport"
import type { SessionRef } from "@/platform/identity/session-ref"
import {
  getSessionPrefetch,
  getSessionPrefetchPromise,
  isSessionPrefetchCurrent,
  runSessionPrefetch,
  sessionHistoryPageRequest,
  SESSION_PREFETCH_TTL,
  setSessionPrefetch,
  type SessionPrefetchDirectory,
} from "@/platform/sync/session-prefetch"
import { fastSessionSwitchAnyQuietDelay } from "@/platform/runtime/session-switch"
import { markRendererPhase } from "@/platform/performance/renderer-trace"

type RailSessionPrefetchOptions = {
  bypassQuiet?: boolean
  workspaceId?: string
  workspaceKind?: "cloud" | "user-hosted"
  sessionRef?: SessionRef
}

export function createRailSessionMessagePrefetch(input: {
  client: SessionClient
  claxedoServerUrl?: string
  workspaceReachable: (workspaceId: string) => boolean
}) {
  const inFlight = new Set<string>()
  let active: { key: string; controller: AbortController } | undefined
  const keyOf = (directory: SessionPrefetchDirectory, sessionID: string) => JSON.stringify([directory, sessionID])
  const supersede = (directory: SessionPrefetchDirectory, sessionID: string) => {
    const key = keyOf(directory, sessionID)
    if (!active || active.key === key) return
    active.controller.abort()
    active = undefined
  }
  const hasFreshPage = (directory: SessionPrefetchDirectory, sessionID: string) => {
    const info = getSessionPrefetch(directory, sessionID)
    return !!info?.page?.messages.length && Date.now() - info.at < SESSION_PREFETCH_TTL
  }

  const start = (
    directory: SessionPrefetchDirectory,
    sessionID: string,
    options: RailSessionPrefetchOptions = {},
  ) => {
    const key = keyOf(directory, sessionID)
    supersede(directory, sessionID)
    if (inFlight.has(key)) return !!getSessionPrefetchPromise(directory, sessionID)
    if (hasFreshPage(directory, sessionID)) return true
    inFlight.add(key)
    if (!options.bypassQuiet && fastSessionSwitchAnyQuietDelay() > 0) {
      inFlight.delete(key)
      return false
    }
    const controller = new AbortController()
    active = { key, controller }
    void runSessionPrefetch({
      directory,
      sessionID,
      task: async (revision) => {
        try {
          markRendererPhase("sessionActivate.prefetch.transportStart")
          const messages = await fetchSessionMessagesByTransport({
          client: input.client,
          directory,
          sessionID,
          claxedoServerUrl: input.claxedoServerUrl,
          ...sessionHistoryPageRequest(),
          sessionRef: options.sessionRef,
          signal: controller.signal,
          bypassQuiet: options.bypassQuiet,
          workspaceReachable: options.workspaceId ? input.workspaceReachable(options.workspaceId) : undefined,
          ...(options.workspaceKind
            ? {
                signedControlPlane: true,
                workspaceKind: options.workspaceKind,
                ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
              }
            : {}),
          })
          markRendererPhase("sessionActivate.prefetch.transportEnd")
          if (controller.signal.aborted) return
          const normalized = normalizeMessageRows(messages.data)
          if (controller.signal.aborted) return
          if (normalized.messages.length === 0) return
          const cursor = messages.response.headers.get("x-next-cursor") ?? undefined
          const next = {
            directory,
            limit: normalized.messages.length,
            complete: !cursor,
            at: Date.now(),
            page: {
              messages: normalized.messages,
              parts: normalized.parts.map((item) => ({ id: item.id, part: item.parts })),
            },
            ...(cursor ? { cursor } : {}),
          }
          const publish = () => {
            if (controller.signal.aborted) return
            if (!isSessionPrefetchCurrent(directory, sessionID, revision)) return
            setSessionPrefetch({ ...next, sessionID })
            return next
          }
          const quietDelay = options.bypassQuiet ? 0 : fastSessionSwitchAnyQuietDelay()
          if (quietDelay <= 0) return publish()
          return await new Promise<typeof next | undefined>((resolve) => {
            setTimeout(() => resolve(publish()), quietDelay + 100)
          })
        } catch (error) {
          if (controller.signal.aborted) return
          throw error
        }
      },
    }).catch(() => undefined).finally(() => {
      inFlight.delete(key)
      if (active?.controller === controller) active = undefined
    })
    return true
  }
  return { start, supersede }
}
