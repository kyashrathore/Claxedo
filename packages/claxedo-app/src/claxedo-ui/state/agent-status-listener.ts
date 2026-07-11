import { batch, createEffect, onCleanup, untrack } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { playSoundById } from "@/utils/sound"
import { getClaxedoServerUrl } from "@/shared/data/api"
import { useClaxedoEventsOptional } from "@/context/claxedo-events"
import { createTransport } from "../../shell/data/transport/transport"
import { terminalPtyApiPath } from "../../terminal/terminal-connection"
import { centralTransportForServer } from "@/shell/data/transport/transport"
import { workspaceResolveUrl } from "@/agent-runtime/workspace-control-routes"
import { useClaxedoState } from "./provider"
import type { ClaxedoStateApi } from "./provider"
import { contentScopeDir, type ContentMeta, type TerminalAgentStatus } from "./types"

function agentStatus(eventType: "Busy" | "Idle" | "UserActionRequired" | "Error"): TerminalAgentStatus {
  if (eventType === "Busy") return "working"
  if (eventType === "Idle") return "idle"
  return "permission"
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
  if (!genericTerminalTitle(current, provider) && !agentGeneratedTitle(current, provider)) return
  const context = contextTitle({ ...input, provider })
  if (!context) return
  const next = provider ? `${provider}: ${context}` : context
  if (next === current) return
  return next
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
      // as-any: SDK event details are opaque, but session.status carries this known payload.
      const event = e.details as unknown as { type: string; properties: Record<string, unknown> }

      if (event.type === "session.status") {
        const { sessionID, status } = event.properties as {
          sessionID: string
          status: { type: string }
        }

        const result = findSessionContent(state, sessionID)
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

        const result = findSessionContent(state, sessionID)
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

  let hadConnection = false

  createEffect(() => {
    if (!claxedoEvents) return
    const isConnected = claxedoEvents.connected()
    if (!isConnected) return
    if (!hadConnection) {
      hadConnection = true
      return
    }
    void reconcileAgentStatuses(state, platform.fetch ?? fetch)
  })
}

function terminalReconnectTargets(state: ClaxedoStateApi) {
  const targets = new Map<string, Set<string>>()
  for (const content of state.meta.all()) {
    const directory = contentScopeDir(content, content.directory)
    if (!directory) continue
    for (const id of ownedTerminalIds(state, content.id)) {
      if (!state.terminal.isTracked(id)) continue
      if (state.terminal.agentStatus(id) === "idle") continue
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

async function reconcileAgentStatuses(state: ClaxedoStateApi, request: typeof fetch) {
  const targets = terminalReconnectTargets(state)
  if (targets.size === 0) return

  let livePtyIds: Set<string>
  try {
    livePtyIds = new Set()
    for (const [directory] of targets) {
      const workspace = await resolveWorkspaceRuntime(directory, request)
      const workspaceId = workspace?.workspaceId
      const ptys = await createTransport({
        placement: {
          ...(workspaceId ? { workspaceId } : {}),
          hosting: "workspace",
          transport: workspaceId && centralTransportForServer(getClaxedoServerUrl()) !== "loopback" ? "workspace-relay" : "loopback",
        },
        serverUrl: getClaxedoServerUrl(),
        directory: workspaceId ? undefined : directory,
        request,
        resolveWorkspaceRuntime: ({ directory }) => resolveWorkspaceRuntime(directory, request),
      }).json<Array<{ id: string }>>(
        terminalPtyApiPath(workspaceId ? { workspaceId } : { directory }),
        { headers: { Accept: "application/json" } },
      )
      for (const pty of ptys) livePtyIds.add(pty.id)
    }
  } catch {
    clearAllAgentIndicators(state)
    return
  }

  untrack(() => {
    batch(() => {
      for (const ids of targets.values()) {
        for (const id of ids) {
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
