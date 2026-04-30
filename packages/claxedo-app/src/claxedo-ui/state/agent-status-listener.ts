import { batch, createEffect, onCleanup, untrack } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useSettings } from "@/context/settings"
import { playSoundById } from "@/utils/sound"
import { getClaxedoServerUrl } from "@claxedo/utils/api"
import { useClaxedoEventsOptional } from "@claxedo/providers/claxedo-events"
import { useClaxedoState } from "./provider"
import type { ClaxedoStateApi } from "./provider"
import type { ContentMeta, TerminalAgentStatus } from "./types"

function agentStatus(eventType: "Busy" | "Idle" | "UserActionRequired" | "Error"): TerminalAgentStatus {
  if (eventType === "Busy") return "working"
  if (eventType === "Idle") return "idle"
  return "permission"
}

function ownedTerminalIds(state: ClaxedoStateApi, contentId: string): string[] {
  const ids: string[] = []
  const meta = state.meta.get(contentId)
  if (meta?.terminalId) ids.push(meta.terminalId)
  // Walk owner map.
  const ownerMap = state.state.terminal.owner
  for (const ptyId of Object.keys(ownerMap)) {
    if (ownerMap[ptyId] !== contentId) continue
    if (!ids.includes(ptyId)) ids.push(ptyId)
  }
  return ids
}

function getContentAgentStatus(
  state: ClaxedoStateApi,
  contentId: string,
): { loading: boolean; attention: boolean; done: boolean } {
  const ids = ownedTerminalIds(state, contentId)
  let hasWorking = false
  let hasPermission = false
  let hasSeen = false
  for (const id of ids) {
    const status = state.terminal.agentStatus(id)
    if (status === "working") hasWorking = true
    if (status === "permission") hasPermission = true
    if (state.terminal.seen(id)) hasSeen = true
  }
  return {
    loading: hasWorking,
    attention: hasPermission,
    done: hasSeen && !hasWorking && !hasPermission,
  }
}

/** Find the pane id (if any) currently displaying `contentId`. */
function paneFor(state: ClaxedoStateApi, contentId: string): string | null {
  return state.wb.selectors.contentPane(contentId)
}

function useAgentLifecycleListener() {
  const state = useClaxedoState()
  const settings = useSettings()
  const claxedoEvents = useClaxedoEventsOptional()

  createEffect(() => {
    if (!claxedoEvents) {
      return
    }

    const unsub = claxedoEvents.on("agent.lifecycle", (event) => {
      const tabId = event.tabId
      const { terminalId, eventType } = event

      const actualTerminalId = terminalId || tabId

      const terminalStatus = agentStatus(eventType)

      batch(() => {
        state.terminal.setAgentStatus(actualTerminalId, terminalStatus)

        // Find the content this event maps to.
        let content: ContentMeta | undefined =
          state.meta.get(tabId) ??
          (terminalId
            ? state.meta.find((m) => m.type === "terminal" && m.terminalId === terminalId)
            : undefined) ??
          state.meta.find((m) => m.type === "terminal" && m.terminalId === tabId)
        if (!content) {
          const ptyId = terminalId || tabId
          const ownerContentId = state.terminal.owner(ptyId)
          if (ownerContentId) content = state.meta.get(ownerContentId)
        }

        if (!content) {
          return
        }

        const paneId = paneFor(state, content.id)
        const isActiveTab =
          !!paneId && state.wb.state.focusedPaneId === paneId

        if (eventType === "Idle" && !isActiveTab) {
          void playSoundById(settings.sounds.agent())
          return
        }
      })
    })

    onCleanup(() => {
      unsub()
    })
  })
}

function useSessionStatusListener() {
  const globalSDK = useGlobalSDK()
  const state = useClaxedoState()
  const settings = useSettings()

  createEffect(() => {
    const unsub = globalSDK.event.listen((e) => {
      const event = e.details as unknown as { type: string; properties: Record<string, any> }
      const directory = e.name

      if (event.type === "session.status") {
        const { sessionID, status } = event.properties as {
          sessionID: string
          status: { type: string }
        }

        const result = findSessionContent(state, directory, sessionID)
        if (!result) return

        const { paneId } = result
        const isActive = !!paneId && state.wb.state.focusedPaneId === paneId

        if (status.type === "idle" && !isActive) {
          void playSoundById(settings.sounds.agent())
        }
      }

      if (event.type === "session.error") {
        const { sessionID } = event.properties as { sessionID?: string }
        if (!sessionID) return

        const result = findSessionContent(state, directory, sessionID)
        if (!result) return

        const { paneId } = result
        const isActive = !!paneId && state.wb.state.focusedPaneId === paneId

        if (!isActive) {
          void playSoundById(settings.sounds.errors())
        }
      }
    })

    onCleanup(unsub)
  })
}

function findSessionContent(
  state: ClaxedoStateApi,
  directory: string,
  sessionId: string,
): { content: ContentMeta; paneId: string | null } | undefined {
  const content = state.meta.find(
    (m) => m.type === "session" && m.directory === directory && m.sessionId === sessionId,
  )
  if (!content) return undefined
  return { content, paneId: paneFor(state, content.id) }
}

function useClearAttentionOnFocus() {
  const state = useClaxedoState()

  createEffect(() => {
    const focusedId = state.wb.selectors.focusedContent()
    if (!focusedId) return
    const content = state.meta.get(focusedId)
    if (!content) return

    const ids = ownedTerminalIds(state, focusedId)
    const aggregated = getContentAgentStatus(state, focusedId)

    if (aggregated.done) {
      for (const id of ids) {
        state.terminal.clearSeen(id)
      }
    }

    if (aggregated.attention) {
      if (content.type !== "terminal") return
      const hadPermission = ids.some(
        (id) => state.terminal.agentStatus(id) === "permission",
      )
      if (!hadPermission) return
      for (const id of ids) {
        if (state.terminal.agentStatus(id) !== "permission") continue
        state.terminal.setAgentStatus(id, "working")
      }
    }
  })
}

function usePtyExitCleanup() {
  const state = useClaxedoState()
  const claxedoEvents = useClaxedoEventsOptional()

  createEffect(() => {
    if (!claxedoEvents) return

    const unsub = claxedoEvents.on("pty.exited", (event) => {
      const ptyId = event.id as string | undefined
      if (!ptyId) return

      if (!state.terminal.isTracked(ptyId)) return
      const status = state.terminal.agentStatus(ptyId)
      if (status === "idle") return

      batch(() => {
        state.terminal.setAgentStatus(ptyId, "idle")
      })
    })

    onCleanup(unsub)
  })
}

function useReconnectCleanup() {
  const state = useClaxedoState()
  const claxedoEvents = useClaxedoEventsOptional()

  let hadConnection = false

  createEffect(() => {
    if (!claxedoEvents) return
    const isConnected = claxedoEvents.connected()
    if (!isConnected) return
    if (!hadConnection) {
      hadConnection = true
      return
    }
    void reconcileAgentStatuses(state)
  })
}

async function reconcileAgentStatuses(state: ClaxedoStateApi) {
  let livePtyIds: Set<string>
  try {
    const res = await fetch(`${getClaxedoServerUrl()}/api/claxedo/pty`)
    if (!res.ok) throw new Error(`PTY list ${res.status}`)
    const ptys = (await res.json()) as Array<{ id: string }>
    livePtyIds = new Set(ptys.map((p) => p.id))
  } catch {
    clearAllAgentIndicators(state)
    return
  }

  untrack(() => {
    batch(() => {
      for (const content of state.meta.all()) {
        const ids = ownedTerminalIds(state, content.id)
        if (ids.length === 0) continue
        for (const id of ids) {
          if (!state.terminal.isTracked(id)) continue
          if (state.terminal.agentStatus(id) === "idle") continue
          if (!livePtyIds.has(id)) {
            state.terminal.setAgentStatus(id, "idle")
            state.terminal.clearSeen(id)
          }
        }
      }
    })
  })
}

function clearAllAgentIndicators(state: ClaxedoStateApi) {
  untrack(() => {
    batch(() => {
      state.terminal.resetAllAgentStatuses()
    })
  })
}

export function useAgentHooks() {
  useAgentLifecycleListener()
  useSessionStatusListener()
  useClearAttentionOnFocus()
  usePtyExitCleanup()
  useReconnectCleanup()
}
