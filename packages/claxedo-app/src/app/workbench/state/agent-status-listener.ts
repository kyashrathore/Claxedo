import { batch, createEffect, on, onCleanup, untrack, type Accessor } from "solid-js"
import { useGlobalSDK } from "@/app/providers/global-sdk/provider"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { useSettings } from "@/platform/settings/provider"
import { playSoundById } from "@/platform/notifications/sound"
import { getClaxedoServerUrl } from "@/platform/api/api"
import { useClaxedoEventsOptional, type ClaxedoEvent } from "@/app/integrations/claxedo-events"
import { createTransport } from "@/platform/runtime/transport"
import { terminalPtyApiPath } from "../../../features/terminal/core/terminal-connection"
import { centralTransportForServer } from "@/platform/runtime/transport"
import { workspaceResolveUrl } from "@/platform/runtime/agent/workspace-control-routes"
import { usePermission } from "@/features/session/providers/permission"
import { useClaxedoState } from "./provider"
import type { ClaxedoStateApi } from "./provider"
import { contentScopeDir, type ContentMeta, type TerminalAgentStatus } from "./types"
import { dispatchSessionStatusEvent } from "@/features/session/store/session-status-dispatcher"
import { terminalAgentStatusFromEventType } from "@/features/terminal/core/terminal-agent-status"
import { parseTerminalSessionPreview, terminalSessionPreviewPath } from "@/features/terminal/lib/terminal-session-preview"
import { readField, readString } from "@/lib/record"

type AgentLifecycleEvent = Extract<ClaxedoEvent, { type: "agent.lifecycle" }>

export function sessionStatusForAgentLifecycle(
  input: Pick<AgentLifecycleEvent, "sessionId" | "terminalId" | "eventType">,
) {
  if (!input.sessionId || input.terminalId) return undefined
  return input.eventType === "Busy" || input.eventType === "UserActionRequired"
    ? { type: "busy" as const }
    : { type: "idle" as const }
}

type LifecycleSounds = {
  agentEnabled: () => boolean
  agent: () => string
  permissionsEnabled: () => boolean
  permissions: () => string
}

/**
 * Which sound a terminal lifecycle frame earns. A focused terminal never
 * plays: the user is already looking at it. Asks arriving while an earlier
 * one is still open stay silent, so Cursor's "Approval 1 of 2" is one sound.
 */
export function terminalLifecycleSound(input: {
  eventType: AgentLifecycleEvent["eventType"]
  outcome?: AgentLifecycleEvent["outcome"]
  previousStatus: TerminalAgentStatus
  focused: boolean
  sounds: LifecycleSounds
}) {
  if (input.focused) return undefined
  if (input.eventType === "Idle" && input.outcome !== "cancelled" && input.sounds.agentEnabled()) {
    return input.sounds.agent()
  }
  if (input.eventType === "UserActionRequired" && input.previousStatus !== "permission" && input.sounds.permissionsEnabled()) {
    return input.sounds.permissions()
  }
  return undefined
}

const clean = (value: unknown) => typeof value === "string" ? value.trim() : ""

const providerLabel = (provider: unknown, currentTitle: unknown) => {
  const value = clean(provider).toLowerCase()
  if (value.includes("claude")) return "Claude"
  if (value.includes("codex")) return "Codex"
  if (value.includes("cursor")) return "Cursor"
  const current = clean(currentTitle).match(/^(Claude|Codex|Cursor)\b/i)?.[1]
  if (!current) return ""
  return current[0]?.toUpperCase() + current.slice(1).toLowerCase()
}

const readable = (value: string) =>
  value
    .replace(/^@+/, "")
    .replace(/[-_][a-z0-9]{4,8}$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b[a-z]/g, (ch) => ch.toUpperCase())

const weakTitle = (value: string) => {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
  return /^(hi|hello|hey|yo|greeting|greetings)$/.test(normalized)
}

const noisyPromptText = (value: string) => {
  const text = clean(value)
  return text.length > 160 || /\b(i'?m|i am)\s+(claude|codex)\b/i.test(text) || /\bai assistant\b/i.test(text)
}

const agentGeneratedTitle = (title: string, provider: string) => {
  if (!provider) return false
  return new RegExp(`^${provider}:\\s+`, "i").test(title)
}

const generatedContext = (title: string, provider: string) => {
  if (!agentGeneratedTitle(title, provider)) return ""
  return title.replace(new RegExp(`^${provider}:\\s+`, "i"), "").trim()
}

const contextTitle = (input: {
  currentTitle?: unknown
  provider?: string
  refName?: unknown
  prompt?: unknown
  lastAssistantMessage?: unknown
}) => {
  const currentContext = generatedContext(clean(input.currentTitle), input.provider ?? "")
  const currentWeak = !currentContext || weakTitle(currentContext)
  const ref = readable(clean(input.refName))
  if (ref && (!currentWeak || !weakTitle(ref))) return ref
  const assistant = readable(clean(input.lastAssistantMessage).replace(/\s+/g, " ").trim().slice(0, 64).replace(/[.?!,:;]+$/g, ""))
  const prompt = clean(input.prompt)
  if ((currentWeak || noisyPromptText(prompt)) && assistant && !weakTitle(assistant)) return assistant
  const text = prompt
  if (!text) return ""
  const first = text
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64)
    .replace(/[.?!,:;]+$/g, "")
  return readable(first)
}

const genericTerminalTitle = (title: string, provider: string) => {
  if (!title) return true
  if (/^Terminal(?:\s+\d+)?$/i.test(title)) return true
  if (!provider) return false
  return new RegExp(`^${provider}(?:\\s+\\d+)?$`, "i").test(title)
}

export function agentLifecycleTitle(input: {
  currentTitle?: unknown
  provider?: unknown
  refName?: unknown
  prompt?: unknown
  lastAssistantMessage?: unknown
}) {
  const provider = providerLabel(input.provider, input.currentTitle)
  const current = clean(input.currentTitle)
  if (!genericTerminalTitle(current, provider) && !agentGeneratedTitle(current, provider)) return undefined
  const context = contextTitle({ ...input, provider })
  if (!context) return undefined
  const next = provider ? `${provider}: ${context}` : context
  if (next === current) return undefined
  return next
}

function ownedTerminalIds(state: AgentStatusReconcileState, contentId: string): string[] {
  const ids = [...state.terminal.ownedIds(contentId)]
  const meta = state.meta.get(contentId)
  if (meta?.terminalId && !ids.includes(meta.terminalId)) ids.push(meta.terminalId)
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

      // Chat lifecycle frames carry a session id but no terminal id. Route
      // those through the canonical session-status cache; treating tabId as a
      // terminal leaves every session row unaware of the busy/idle change.
      const sessionStatus = sessionStatusForAgentLifecycle(event)
      if (sessionStatus && event.sessionId) {
        dispatchSessionStatusEvent({
          event: {
            type: "session.status",
            source: "server",
            sessionID: event.sessionId,
            status: sessionStatus,
          },
        })
        return
      }

      const actualTerminalId = terminalId || tabId

      const terminalStatus = terminalAgentStatusFromEventType(eventType)
      if (!terminalStatus) return
      const previousStatus = state.terminal.agentStatus(actualTerminalId)

      batch(() => {
        state.terminal.setAgentStatus(actualTerminalId, terminalStatus)
        if (event.outcome === "cancelled") state.terminal.clearSeen(actualTerminalId)

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

        const nextTitle = content.type === "terminal"
          ? agentLifecycleTitle({
            currentTitle: content.content?.title,
            provider: event.provider,
            refName: event.refName,
            prompt: event.prompt,
            lastAssistantMessage: event.lastAssistantMessage,
          })
          : undefined
        if (nextTitle && content.directory && content.terminalId && content.content?.title !== nextTitle) {
          state.meta.patch(content.id, {
            content: {
              ...content.content,
              type: "terminal",
              directory: content.directory,
              terminalId: content.terminalId,
              title: nextTitle,
            },
          })
        }

        const paneId = paneFor(state, content.id)
        const sound = terminalLifecycleSound({
          eventType,
          outcome: event.outcome,
          previousStatus,
          focused: !!paneId && state.wb.state.focusedPaneId === paneId,
          sounds: settings.sounds,
        })
        if (sound) void playSoundById(sound)
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
  const permission = usePermission()

  createEffect(() => {
    const unsub = globalSDK.event.listen((e) => {
      const type = readString(e.details, "type")
      const sessionID = readString(readField(e.details, "properties"), "sessionID")

      if (e.details?.type === "permission.asked") {
        if (permission.autoResponds(e.details.properties, e.name)) return
        const result = findSessionContent(state, e.details.properties.sessionID)
        if (!result) return

        const { paneId } = result
        const isActive = !!paneId && state.wb.state.focusedPaneId === paneId

        if (!isActive && settings.sounds.permissionsEnabled()) {
          void playSoundById(settings.sounds.permissions())
        }
      }

      if (type === "session.idle" && sessionID) {
        const result = findSessionContent(state, sessionID)
        if (!result) return

        const { paneId } = result
        const isActive = !!paneId && state.wb.state.focusedPaneId === paneId

        if (!isActive && settings.sounds.agentEnabled()) {
          void playSoundById(settings.sounds.agent())
        }
      }

      if (type === "session.error" && sessionID) {
        const result = findSessionContent(state, sessionID)
        if (!result) return

        const { paneId } = result
        const isActive = !!paneId && state.wb.state.focusedPaneId === paneId

        if (!isActive && settings.sounds.errorsEnabled()) {
          void playSoundById(settings.sounds.errors())
        }
      }
    })

    onCleanup(unsub)
  })
}

function findSessionContent(
  state: ClaxedoStateApi,
  sessionId: string,
): { content: ContentMeta; paneId: string | null } | undefined {
  const content = state.meta.find(
    (m) => m.type === "session" && m.sessionId === sessionId,
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

/**
 * Reconcile a single tracked terminal after its PTY exits externally.
 *
 * An externally-exited PTY is done: it must both drop to `idle` AND clear the
 * `seen` flag, matching the reconnect-reconcile path (see
 * `reconcileAgentStatuses` below, which pairs `setAgentStatus(id, "idle")` with
 * `clearSeen(id)`). Setting `idle` alone leaves a stale `seen` flag, which the
 * status aggregator reads as `done` (`seen && !working && !permission`), so the
 * sidebar "done" dot sticks forever and never disappears.
 *
 * Returns true when the terminal was tracked, non-idle, and got reconciled.
 */
export function reconcilePtyExit(
  state: Pick<ClaxedoStateApi, "terminal">,
  ptyId: string | undefined,
): boolean {
  if (!ptyId) return false
  if (!state.terminal.isTracked(ptyId)) return false
  if (state.terminal.agentStatus(ptyId) === "idle") return false
  batch(() => {
    state.terminal.setAgentStatus(ptyId, "idle")
    state.terminal.clearSeen(ptyId)
  })
  return true
}

function usePtyExitCleanup() {
  const state = useClaxedoState()
  const claxedoEvents = useClaxedoEventsOptional()

  createEffect(() => {
    if (!claxedoEvents) return

    const unsub = claxedoEvents.on("pty.exited", (event) => {
      reconcilePtyExit(state, event.id as string | undefined)
    })

    onCleanup(unsub)
  })
}

function useReconnectCleanup() {
  const state = useClaxedoState()
  const claxedoEvents = useClaxedoEventsOptional()
  const platform = usePlatform()

  if (!claxedoEvents) return

  useReconnectReconciliation({
    connected: claxedoEvents.workspaceConnected,
    reconnects: claxedoEvents.workspaceReconnects,
    reconcile: () => reconcileAgentStatuses(state, platform.fetch ?? fetch),
  })
}

/**
 * The agent statuses reconciled here are driven by `agent.lifecycle` and
 * `pty.*` frames, which ride a workspace runtime's stream (`wr`) — so the
 * edge is that stream's return. The aggregate `connected()` never drops
 * while the control plane's stream holds it up, and a `wr`-only outage
 * across a `pty.exited` would leave a terminal pinned "busy". A workspace
 * switch is a return too, and so is the first stream of a page load: the
 * indicators persisted from before it are stale in the same way.
 *
 * Two `wr` streams are open at once on a signed desktop — the daemon's host
 * aggregate and a routed relay-backed workspace's own — and the level cannot
 * show the return of one while the other holds it up, so the per-kind edge
 * counter is the other half of the edge. That workspace's Runtime Access
 * Token expires every ten minutes, so its return is the routine case.
 */
export function useReconnectReconciliation(input: {
  connected: Accessor<boolean>
  reconnects: Accessor<number>
  reconcile: () => void | Promise<void>
}) {
  // `on` runs these callbacks untracked. Reconciliation synchronously snapshots
  // metadata and terminal statuses before its first await; those reads must not
  // turn later title/status changes into another network reconciliation while
  // the connection remains up.
  createEffect(on(input.connected, (isConnected) => {
    if (!isConnected) return
    void input.reconcile()
  }))
  // Deferred: the count's initial value is not an edge, and the level's own
  // first reconcile above already covers the page load.
  createEffect(on(input.reconnects, () => void input.reconcile(), { defer: true }))
}

/** What the reconciliation reads and writes: the terminals each content owns, and their indicators. */
export type AgentStatusReconcileState = {
  terminal: Pick<ClaxedoStateApi["terminal"], "ownedIds" | "agentStatus" | "setAgentStatus" | "clearSeen">
  meta: Pick<ClaxedoStateApi["meta"], "all" | "get">
}

// Every terminal a content owns, whatever its indicator says: a terminal
// whose agent started while its workspace was not routed shows nothing yet.
function terminalReconnectTargets(state: AgentStatusReconcileState) {
  const targets = new Map<string, Set<string>>()
  for (const content of state.meta.all()) {
    const directory = contentScopeDir(content, content.directory)
    if (!directory) continue
    for (const id of ownedTerminalIds(state, content.id)) {
      const ids = targets.get(directory) ?? new Set<string>()
      ids.add(id)
      targets.set(directory, ids)
    }
  }
  return targets
}

async function resolveWorkspaceRuntime(directory: string, request: typeof fetch) {
  const res = await request(workspaceResolveUrl({
    baseUrl: getClaxedoServerUrl(),
    scope: directory,
  }), {
    headers: { Accept: "application/json" },
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error((await res.text()) || `workspace resolve failed: ${res.status}`)
  return await res.json()
}

/**
 * Re-reads, from the runtime, what the workspace stream would have told us
 * had it been open: which owned terminals still exist, and for those that
 * do, the last lifecycle the runtime recorded (`/hook/terminal-session`).
 * Only the routed workspace's stream is open, so a terminal in another
 * workspace whose agent started, asked or finished meanwhile is healed
 * here, on the next return of a workspace stream. Each directory is read
 * on its own, and each live terminal applied as its record arrives: a
 * workspace whose host is away keeps its indicators as they were rather
 * than clearing every other workspace's, a slow one does not hold a fast
 * one's answer, and a live frame that lands during a read outranks the
 * record read before it. A reconcile started later supersedes this one.
 * A heal writes the indicator only — a completion it reveals plays no
 * sound, and a live Idle's "done" mark (`seen`) is left as the live path
 * leaves it; only a terminal that is gone loses it.
 */
export async function reconcileAgentStatuses(state: AgentStatusReconcileState, request: typeof fetch) {
  const targets = terminalReconnectTargets(state)
  if (targets.size === 0) return
  const generation = ++reconcileGeneration

  for (const [directory, ids] of targets) {
    const gone = new Set<string>()
    try {
      const workspace = await resolveWorkspaceRuntime(directory, request)
      const workspaceId = workspace?.workspaceId
      const relayWorkspaceId = workspaceId && centralTransportForServer(getClaxedoServerUrl()) !== "loopback"
        ? workspaceId
        : undefined
      const transport = createTransport({
        placement: {
          ...(relayWorkspaceId ? { workspaceId: relayWorkspaceId } : {}),
          hosting: "workspace",
          transport: relayWorkspaceId ? "workspace-relay" : "loopback",
        },
        serverUrl: getClaxedoServerUrl(),
        directory: relayWorkspaceId ? undefined : directory,
        request,
        resolveWorkspaceRuntime: ({ directory }) => resolveWorkspaceRuntime(directory, request),
      })
      // A local workspace can still have a stable workspaceId. That identity
      // does not make its loopback HTTP surface relay-shaped: `/workspaces/:id`
      // exists at the relay edge, while the local runtime is addressed by
      // `?directory=...`.
      const ptys = await transport.json(
        terminalPtyApiPath(relayWorkspaceId ? { workspaceId: relayWorkspaceId } : { directory }),
        { headers: { Accept: "application/json" } },
      )
      const live = new Set<string>()
      for (const pty of Array.isArray(ptys) ? ptys : []) {
        const id = readString(pty, "id")
        if (id) live.add(id)
      }
      for (const id of ids) {
        if (!live.has(id)) {
          gone.add(id)
          continue
        }
        // Read against the indicator as it was when the read began: a live
        // frame landing meanwhile is newer than what the runtime recorded
        // before it, and keeps its say.
        const before = state.terminal.agentStatus(id)
        const recorded = await transport
          .json(terminalSessionPreviewPath(id, relayWorkspaceId ? undefined : directory), { headers: { Accept: "application/json" } })
          .then(parseTerminalSessionPreview)
          .catch(() => null)
        if (generation !== reconcileGeneration) return
        const status = terminalAgentStatusFromEventType(recorded?.eventType)
        if (status && state.terminal.agentStatus(id) === before && status !== before) {
          untrack(() => state.terminal.setAgentStatus(id, status))
        }
      }
    } catch {
      continue
    }
    if (generation !== reconcileGeneration) return
    untrack(() => {
      batch(() => {
        for (const id of gone) {
          if (state.terminal.agentStatus(id) !== "idle") state.terminal.setAgentStatus(id, "idle")
          state.terminal.clearSeen(id)
        }
      })
    })
  }
}

let reconcileGeneration = 0

export function useAgentHooks() {
  useAgentLifecycleListener()
  useSessionStatusListener()
  useClearAttentionOnFocus()
  usePtyExitCleanup()
  useReconnectCleanup()
}
