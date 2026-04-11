/**
 * Agent Lifecycle Listener
 *
 * Subscribes to agent.lifecycle events from the server and updates
 * tab status indicators (loading spinner, attention dot).
 *
 * STATUS TRACKING:
 * - Status is tracked PER TERMINAL (PTY ID), not per tab
 * - Tab status is AGGREGATED from all terminals within the tab
 * - This allows multiple agents to run in split terminals correctly
 *
 * SESSION STATUS TRACKING:
 * - Subscribes to session.status events to show loading/done dots on session tabs
 * - Sound is played when a session completes and the tab is not active
 * - This unifies the notification behavior between terminal CLI agents and sessions
 */

import { batch, createEffect, onCleanup, untrack } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useSettings } from "@/context/settings"
import { playSoundById } from "@/utils/sound"
import { getClaxedoServerUrl } from "@claxedo/utils/api"
import { useClaxedoLayout, type TabItem, type TerminalAgentStatus } from "@claxedo/claxedo-ui/context/claxedo-layout"
import { useClaxedoEventsOptional } from "@claxedo/providers/claxedo-events"
import { createDebugLogger } from "@claxedo/overrides/utils/debug"

const lifecycleDebug = createDebugLogger("agent.lifecycle", "agent:lifecycle", { defaultLevel: 0 })
const verbose = import.meta.env.VITE_AGENT_LIFECYCLE_DEBUG === "true"
const vlog = (...args: unknown[]) => {
  if (!verbose) return
  console.info("[agent.lifecycle]", ...args)
}

function agentStatus(eventType: "Busy" | "Idle" | "UserActionRequired" | "Error"): TerminalAgentStatus {
  if (eventType === "Busy") return "working"
  if (eventType === "Idle") return "idle"
  return "permission"
}

/**
 * Hook that listens for agent lifecycle events and updates tab status
 *
 * STATUS MAPPING:
 * - Busy → loading: true (amber spinning indicator)
 * - Idle → loading: false
 * - UserActionRequired → attention: true (red pulsing dot)
 * - Error → permission terminal state for compatibility with existing aggregation
 *
 * The attention indicator is cleared when the user focuses the tab.
 *
 * Note: Uses claxedo events bus (SSE from claxedo-server) for agent lifecycle events.
 */
export function useAgentLifecycleListener() {
  const claxedo = useClaxedoLayout()
  const settings = useSettings()
  const claxedoEvents = useClaxedoEventsOptional()

  createEffect(() => {
    if (!claxedoEvents) {
      vlog("missing claxedoEvents bus")
      return
    }

    // Listen to claxedo bus for agent lifecycle events (flat structure, no properties wrapper)
    const unsub = claxedoEvents.on("agent.lifecycle", (event) => {
      const { tabId, terminalId, eventType } = event

      const actualTerminalId = terminalId || tabId

      lifecycleDebug.log("event", { eventType, tabId, terminalId, actualTerminalId })
      vlog("event", { eventType, tabId, terminalId, actualTerminalId })

      // Server normalizes before publishing: Start→Busy, Stop→Idle, PermissionRequest→UserActionRequired
      const terminalStatus = agentStatus(eventType)

      // batch() ensures all store updates (setAgentStatus + patchTab) are atomic.
      // Without it, setAgentStatus triggers reactive effects before patchTab runs,
      // causing pane status to briefly see "idle" + tab.done=false → grey instead of green.
      batch(() => {
        claxedo.terminal.setAgentStatus(actualTerminalId, terminalStatus)

        // Find the tab across ALL groups (not just focused group)
        const groups = claxedo.split.groups()
        let tab: TabItem | undefined
        let tabGroupId: string | undefined

        for (const group of groups) {
          const allTabs = group.tabs.items
          let found = allTabs.find((t) => t.id === tabId)
          if (!found && terminalId) {
            found = allTabs.find((t) => t.type === "terminal" && t.terminalId === terminalId)
          }
          if (!found) {
            found = allTabs.find((t) => t.type === "terminal" && t.terminalId === tabId)
          }
          if (!found) {
            const ptyId = terminalId || tabId
            const ownerTabId = claxedo.terminal.owner(ptyId)
            if (ownerTabId) {
              found = allTabs.find((t) => t.id === ownerTabId)
            }
          }
          if (found) {
            tab = found
            tabGroupId = group.id
            break
          }
        }

        if (!tab || !tabGroupId) {
          lifecycleDebug.log("tab not found", { tabId, terminalId })
          vlog("tab not found", { tabId, terminalId, actualTerminalId })
          return
        }

        // Check if this tab is currently active in its group and the group is focused
        const isActiveTab =
          claxedo.split.focusedId() === tabGroupId &&
          groups.find((g) => g.id === tabGroupId)?.tabs.activeId === tab.id
        vlog("tab resolved", {
          tabId: tab.id,
          tabGroupId,
          isActiveTab,
          eventType,
          actualTerminalId,
        })

        // For Idle events: show done dot if tab is not active (user is "away")
        // This handles Codex which doesn't send Busy events
        if (eventType === "Idle" && !isActiveTab) {
          claxedo.patchTab(tab.id, { loading: false, done: true })
          // Play sound notification
          void playSoundById(settings.sounds.agent())
          vlog("idle handled (inactive)", { tabId: tab.id })
          return
        }

        // Compute aggregated tab status from all terminals in this tab
        const aggregated = claxedo.terminal.getTabAgentStatus(tab.id)

        // Update the tab with aggregated status
        const patch: { loading: boolean; attention?: boolean; done?: boolean } = {
          loading: aggregated.loading,
          done: aggregated.done,
        }

        // Attention handling:
        // - Set attention=true when THIS terminal sends PermissionRequest
        // - Clear attention only when all terminals are idle (no more permission needed)
        // - User focus clears attention (handled by useClearAttentionOnFocus)
        if (eventType === "UserActionRequired") {
          patch.attention = true
        } else if (!aggregated.attention) {
          patch.attention = false
        }

        claxedo.patchTab(tab.id, patch)
        vlog("tab patched", { tabId: tab.id, patch, aggregated })
      })
    })

    onCleanup(() => {
      unsub()
    })
  })
}

/**
 * Hook that listens for session status events and updates session tab indicators
 *
 * STATUS MAPPING:
 * - session.status busy/retry → loading: true (amber spinning indicator)
 * - session.status idle → loading: false, done: true if tab is inactive
 * - session.error → loading: false, done: true if tab is inactive
 *
 * Sound is played when a session completes/errors and the tab is not active,
 * matching the behavior of terminal CLI agents.
 */
export function useSessionStatusListener() {
  const globalSDK = useGlobalSDK()
  const claxedo = useClaxedoLayout()
  const settings = useSettings()

  createEffect(() => {
    // Listen to all directories for session events
    const unsub = globalSDK.event.listen((e) => {
      const event = e.details as unknown as { type: string; properties: Record<string, any> }
      const directory = e.name

      if (event.type === "session.status") {
        const { sessionID, status } = event.properties as {
          sessionID: string
          status: { type: string }
        }

        const result = findSessionTab(claxedo.split.groups(), directory, sessionID)
        if (!result) return

        const { tab, groupId } = result
        const isActive =
          claxedo.split.focusedId() === groupId &&
          claxedo.split.groups().find((g) => g.id === groupId)?.tabs.activeId === tab.id

        if (status.type === "busy" || status.type === "retry") {
          claxedo.patchTab(tab.id, { loading: true, done: false })
        } else if (status.type === "recovering") {
          claxedo.patchTab(tab.id, { loading: false, done: false })
        } else if (status.type === "idle") {
          if (!isActive) {
            claxedo.patchTab(tab.id, { loading: false, done: true })
            void playSoundById(settings.sounds.agent())
          } else {
            claxedo.patchTab(tab.id, { loading: false })
          }
        }
      }

      if (event.type === "session.error") {
        const { sessionID } = event.properties as { sessionID?: string }
        if (!sessionID) return

        const result = findSessionTab(claxedo.split.groups(), directory, sessionID)
        if (!result) return

        const { tab, groupId } = result
        const isActive =
          claxedo.split.focusedId() === groupId &&
          claxedo.split.groups().find((g) => g.id === groupId)?.tabs.activeId === tab.id

        if (!isActive) {
          claxedo.patchTab(tab.id, { loading: false, done: true })
          void playSoundById(settings.sounds.errors())
        } else {
          claxedo.patchTab(tab.id, { loading: false })
        }
      }
    })

    onCleanup(unsub)
  })
}

/** Find a session tab by directory + sessionId across all groups */
function findSessionTab(
  groups: { id: string; tabs: { items: TabItem[]; activeId: string | null } }[],
  directory: string,
  sessionId: string,
): { tab: TabItem; groupId: string } | undefined {
  for (const group of groups) {
    const tab = group.tabs.items.find(
      (t) => t.type === "session" && t.directory === directory && t.sessionId === sessionId,
    )
    if (tab) return { tab, groupId: group.id }
  }
  return undefined
}

/**
 * Hook that clears attention and done indicators when user focuses a tab
 *
 * This provides a natural UX:
 * - The attention dot disappears when the user switches to the tab
 * - The done dot disappears when the user switches to the tab (they've seen the results)
 */
export function useClearAttentionOnFocus() {
  const claxedo = useClaxedoLayout()

  createEffect(() => {
    const activeId = claxedo.topTabs.activeId()
    if (!activeId) return

    const tab = claxedo.topTabs.items().find((t) => t.id === activeId)
    if (!tab) return

    // Get all terminal IDs in this tab
    const ids = claxedo.terminal.ids(activeId)
    const nextIds = tab.terminalId ? [...ids, tab.terminalId] : ids
    const unique = Array.from(new Set(nextIds))

    // Only clear the seen flag if the agent has completed (done is true).
    // If the agent is still running (loading=true), we need to keep the seen flag
    // so that when Stop arrives, we know the agent actually ran (preventing spurious done).
    if (tab.done) {
      for (const id of unique) {
        claxedo.terminal.clearSeen(id)
      }

      // Update the tab's done status immediately to hide the green dot.
      // For session tabs (no terminals), getTabAgentStatus returns done:false which clears it.
      const aggregated = claxedo.terminal.getTabAgentStatus(activeId)
      claxedo.patchTab(activeId, { done: aggregated.done })
    }

    if (tab?.attention) {
      // Clear attention when tab is focused
      claxedo.patchTab(activeId, { attention: false })

      // Heuristic: when a terminal tab is focused while it was in "permission" state,
      // assume the user is about to respond and restore the "working" indicator.
      // Claude Code permission hooks don't emit a "resume" event, so without this
      // the tab can remain stuck in attention/no-spinner until Stop.
      if (tab.type !== "terminal") return

      const hadPermission = unique.some((id) => claxedo.terminal.agentStatus(id) === "permission")
      if (!hadPermission) return

      for (const id of unique) {
        if (claxedo.terminal.agentStatus(id) !== "permission") continue
        claxedo.terminal.setAgentStatus(id, "working")
      }

      const aggregated = claxedo.terminal.getTabAgentStatus(activeId)
      claxedo.patchTab(activeId, { loading: aggregated.loading, done: aggregated.done })
    }
  })
}

/**
 * Hook that clears stuck agent status indicators when a PTY exits.
 *
 * This is a defense-in-depth frontend fallback for when the server-side
 * agent.lifecycle Idle emit doesn't arrive (e.g. network drop). It
 * subscribes to pty.exited events and clears any "working" or "permission"
 * status left on the terminal.
 */
export function usePtyExitCleanup() {
  const claxedo = useClaxedoLayout()
  const claxedoEvents = useClaxedoEventsOptional()

  createEffect(() => {
    if (!claxedoEvents) return

    // Listen to claxedo bus for PTY exit events (flat structure, no properties wrapper)
    const unsub = claxedoEvents.on("pty.exited", (event) => {
      const ptyId = event.id as string | undefined
      if (!ptyId) return

      // Only act if this terminal was tracked and still has a non-idle status
      if (!claxedo.terminal.isTracked(ptyId)) return
      const status = claxedo.terminal.agentStatus(ptyId)
      if (status === "idle") return

      lifecycleDebug.log("pty.exited cleanup", { ptyId, previousStatus: status })

      batch(() => {
        claxedo.terminal.setAgentStatus(ptyId, "idle")

        const ownerTabId = claxedo.terminal.owner(ptyId)
        if (!ownerTabId) return

        const aggregated = claxedo.terminal.getTabAgentStatus(ownerTabId)
        claxedo.patchTab(ownerTabId, {
          loading: aggregated.loading,
          done: aggregated.done,
          attention: aggregated.attention ? undefined : false,
        })
      })
    })

    onCleanup(unsub)
  })
}

/**
 * Hook that reconciles agent status indicators when the SSE connection
 * reconnects after a disconnect.
 *
 * Two scenarios cause SSE disconnects:
 * 1. **Server restart** — PTYs are dead, no Idle events were sent. Indicators
 *    are stale and must be cleared.
 * 2. **Network blip** (Wi-Fi hiccup, laptop sleep) — server and agents are
 *    still running. Indicators are accurate and must be preserved.
 *
 * To distinguish: on reconnect, fetch the PTY list from the server. If a
 * tracked terminal's PTY no longer exists, the server restarted → clear it.
 * If the PTY still exists, the agent is likely still running → keep it.
 */
export function useReconnectCleanup() {
  const claxedo = useClaxedoLayout()
  const claxedoEvents = useClaxedoEventsOptional()

  // Track whether we've ever been connected — reconciliation only fires
  // after the first disconnect+reconnect cycle, not on initial connect
  // (init cleanup in claxedo-layout.tsx already handles the page-load case).
  let hadConnection = false

  createEffect(() => {
    if (!claxedoEvents) return
    const isConnected = claxedoEvents.connected()

    if (!isConnected) return

    if (!hadConnection) {
      hadConnection = true
      return
    }

    // SSE reconnected — reconcile with server to distinguish
    // server restart (clear stale) from network blip (keep state).
    lifecycleDebug.log("SSE reconnected — reconciling agent statuses")
    void reconcileAgentStatuses(claxedo)
  })
}

/** Fetch live PTY IDs from the server and clear indicators for PTYs that no longer exist. */
async function reconcileAgentStatuses(claxedo: ReturnType<typeof useClaxedoLayout>) {
  let livePtyIds: Set<string>
  try {
    const res = await fetch(`${getClaxedoServerUrl()}/api/claxedo/pty`)
    if (!res.ok) throw new Error(`PTY list ${res.status}`)
    const ptys = (await res.json()) as Array<{ id: string }>
    livePtyIds = new Set(ptys.map((p) => p.id))
  } catch {
    // Server unreachable — it restarted and isn't ready yet, or truly crashed.
    // Clear everything; fresh events will re-establish if agents are alive.
    lifecycleDebug.log("PTY fetch failed — clearing all stale statuses")
    clearAllAgentIndicators(claxedo)
    return
  }

  // Check each tracked terminal against the server's live PTY list
  untrack(() => {
    let cleared = 0
    batch(() => {
      const groups = claxedo.split.groups()
      for (const group of groups) {
        for (const tab of group.tabs.items) {
          if (!tab.loading && !tab.attention) continue

          // Collect terminal IDs for this tab
          const ids = claxedo.terminal.ids(tab.id)
          if (tab.terminalId && !ids.includes(tab.terminalId)) ids.push(tab.terminalId)
          if (ids.length === 0) continue

          // Check if ANY tracked terminal's PTY is gone from the server
          let hasStale = false
          for (const id of ids) {
            if (!claxedo.terminal.isTracked(id)) continue
            if (claxedo.terminal.agentStatus(id) === "idle") continue
            if (!livePtyIds.has(id)) {
              claxedo.terminal.setAgentStatus(id, "idle")
              claxedo.terminal.clearSeen(id)
              hasStale = true
              cleared++
            }
          }

          if (hasStale) {
            const aggregated = claxedo.terminal.getTabAgentStatus(tab.id)
            claxedo.patchTab(tab.id, {
              loading: aggregated.loading,
              attention: aggregated.attention ? undefined : false,
            })
          }
        }
      }
    })
    lifecycleDebug.log("reconciliation complete", { cleared, livePtys: livePtyIds.size })
  })
}

function clearAllAgentIndicators(claxedo: ReturnType<typeof useClaxedoLayout>) {
  untrack(() => {
    batch(() => {
      claxedo.terminal.resetAllAgentStatuses()

      const groups = claxedo.split.groups()
      for (const group of groups) {
        for (const tab of group.tabs.items) {
          if (tab.loading || tab.attention) {
            claxedo.patchTab(tab.id, { loading: false, attention: false })
          }
        }
      }
    })
  })
}

/**
 * Combined hook for agent lifecycle handling
 * Use this in a top-level component
 */
export function useAgentHooks() {
  useAgentLifecycleListener()
  useSessionStatusListener()
  useClearAttentionOnFocus()
  usePtyExitCleanup()
  useReconnectCleanup()
}
