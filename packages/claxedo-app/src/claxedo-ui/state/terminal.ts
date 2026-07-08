// Terminal slice — owner / agentStatus / agentSeen / lifecycle.
//
// Transient signals for pending terminal actions stay encapsulated here as
// createSignal-backed locals. They are not part of the persisted ClaxedoState
// and callers never read them across reloads.

import { createSignal, untrack } from "solid-js"
import type { SetStoreFunction } from "solid-js/store"
import type { ClaxedoState, TerminalAgentStatus, TerminalLifecycleState } from "./types"

type PendingTabTerminalCreate = {
  contentId: string
  directory: string
  command?: string
  title?: string
  paneId?: string
  previousPtyId?: string
}

const lifecycleTransition: Record<TerminalLifecycleState, Set<TerminalLifecycleState>> = {
  creating: new Set<TerminalLifecycleState>(["attaching", "attached", "closing", "closed"]),
  attaching: new Set<TerminalLifecycleState>(["attached", "closing", "closed"]),
  attached: new Set<TerminalLifecycleState>(["closing", "closed"]),
  closing: new Set<TerminalLifecycleState>(["closed"]),
  closed: new Set<TerminalLifecycleState>(["creating", "attaching", "attached"]),
}

export type TerminalSliceApi = {
  // ── persisted slice readers ─────────────────────────────────────────────
  agentStatus(terminalId: string): TerminalAgentStatus
  isTracked(terminalId: string): boolean
  setAgentStatus(terminalId: string, status: TerminalAgentStatus): void
  clearAgentStatus(terminalId: string): void
  seen(terminalId: string): boolean
  clearSeen(terminalId: string): void
  resetAllAgentStatuses(): void

  owner(terminalId: string): string | undefined
  /** Mark a content as the owner of a terminal. */
  own(contentId: string, terminalId: string): void
  disown(terminalId: string): void
  /** PTY ids currently owned by a process (`process:*`). */
  processOwnedPtyIds(): string[]

  lifecycle(terminalId: string): TerminalLifecycleState | undefined
  transitionLifecycle(
    terminalId: string,
    next: TerminalLifecycleState,
    reason?: string,
  ): boolean

  /** Clear all per-content terminal state (owner/lifecycle/agentStatus/agentSeen). */
  clearForContent(contentId: string): void
  /** Replace a terminalId across all maps (owner/lifecycle/agentStatus/agentSeen). */
  replaceId(oldId: string, newId: string): void

  // ── transient (in-memory only) ──────────────────────────────────────────
  queueCreateForContent(
    contentId: string,
    dir: string,
    command?: string,
    title?: string,
    paneId?: string,
    previousPtyId?: string,
  ): void
  peekCreateForContent(contentId: string): PendingTabTerminalCreate | undefined
  consumeCreateForContent(contentId: string): PendingTabTerminalCreate | undefined
  clearCreateForContent(contentId: string): void

  isClosing(terminalId: string): boolean
  beginClosing(terminalId: string): void
  clearClosing(terminalId: string): void

  pendingProcessStarts(): number
  expectProcessPty(): void
  resolveProcessPty(): void
  resolveInitialProcessPty(): void
}

export function createTerminalSlice(input: {
  state: ClaxedoState
  setState: SetStoreFunction<ClaxedoState>
}): TerminalSliceApi {
  const { state, setState } = input

  // ── transient signals ─────────────────────────────────────────────────
  const [pendingTabCreates, setPendingTabCreates] = createSignal<Record<string, PendingTabTerminalCreate>>({})
  const [closingIds, setClosingIds] = createSignal<string[]>([])
  // See old terminal.ts: start at 1 so process PTYs arriving before
  // ProcessPaneProvider mounts don't get auto-tabbed.
  const [pendingProcessStarts, setPendingProcessStarts] = createSignal(1)
  setTimeout(() => {
    setPendingProcessStarts((n) => (n === 1 ? 0 : n))
  }, 15_000)

  const transitionLifecycle = (
    id: string,
    next: TerminalLifecycleState,
    _reason?: string,
  ): boolean => {
    const current = state.terminal.lifecycle[id]
    if (current === next) return true
    const allowed =
      current === undefined
        ? new Set<TerminalLifecycleState>(["creating", "attaching", "attached", "closing", "closed"])
        : lifecycleTransition[current]
    if (allowed.has(next)) {
      setState("terminal", "lifecycle", id, next)
      return true
    }
    return false
  }

  return {
    agentStatus(terminalId) {
      return state.terminal.agentStatus[terminalId] ?? "idle"
    },
    isTracked(terminalId) {
      return state.terminal.agentStatus[terminalId] !== undefined
    },
    setAgentStatus(terminalId, status) {
      setState("terminal", "agentStatus", terminalId, status)
      if (status !== "idle") {
        setState("terminal", "agentSeen", terminalId, true)
      }
    },
    clearAgentStatus(terminalId) {
      setState("terminal", "agentStatus", terminalId, undefined)
    },
    seen(terminalId) {
      return !!state.terminal.agentSeen[terminalId]
    },
    clearSeen(terminalId) {
      setState("terminal", "agentSeen", terminalId, undefined)
    },
    resetAllAgentStatuses() {
      for (const id of Object.keys(state.terminal.agentStatus)) {
        setState("terminal", "agentStatus", id, undefined)
      }
      for (const id of Object.keys(state.terminal.agentSeen)) {
        setState("terminal", "agentSeen", id, undefined)
      }
    },

    owner(terminalId) {
      return state.terminal.owner[terminalId]
    },
    own(contentId, terminalId) {
      setState("terminal", "owner", terminalId, contentId)
    },
    disown(terminalId) {
      setState("terminal", "owner", terminalId, undefined)
    },
    processOwnedPtyIds() {
      return Object.entries(state.terminal.owner)
        .filter(([, v]) => typeof v === "string" && v.startsWith("process:"))
        .map(([k]) => k)
    },

    lifecycle(terminalId) {
      return state.terminal.lifecycle[terminalId]
    },
    transitionLifecycle,

    clearForContent(contentId) {
      const owned = Object.entries(state.terminal.owner)
        .filter(([, v]) => v === contentId)
        .map(([k]) => k)
      for (const id of owned) {
        setState("terminal", "owner", id, undefined)
        setState("terminal", "agentStatus", id, undefined)
        setState("terminal", "agentSeen", id, undefined)
        setState("terminal", "lifecycle", id, "closing")
      }
    },

    replaceId(oldId, newId) {
      const ownerVal = state.terminal.owner[oldId]
      if (ownerVal !== undefined) {
        setState("terminal", "owner", newId, ownerVal)
        setState("terminal", "owner", oldId, undefined)
      }
      const lifecycleVal = state.terminal.lifecycle[oldId]
      if (lifecycleVal !== undefined) {
        setState("terminal", "lifecycle", newId, lifecycleVal)
        setState("terminal", "lifecycle", oldId, undefined)
      }
      const statusVal = state.terminal.agentStatus[oldId]
      if (statusVal !== undefined) {
        setState("terminal", "agentStatus", newId, statusVal)
        setState("terminal", "agentStatus", oldId, undefined)
      }
      const seenVal = state.terminal.agentSeen[oldId]
      if (seenVal !== undefined) {
        setState("terminal", "agentSeen", newId, seenVal)
        setState("terminal", "agentSeen", oldId, undefined)
      }
    },

    // ── transient ─────────────────────────────────────────────────────
    queueCreateForContent(contentId, dir, command, title, paneId, previousPtyId) {
      setPendingTabCreates((all) => ({
        ...all,
        [contentId]: { contentId, directory: dir, command, title, paneId, previousPtyId },
      }))
    },
    peekCreateForContent(contentId) {
      return pendingTabCreates()[contentId]
    },
    consumeCreateForContent(contentId) {
      const next = pendingTabCreates()[contentId]
      if (!next) return undefined
      setPendingTabCreates((all) => {
        const copy = { ...all }
        delete copy[contentId]
        return copy
      })
      return next
    },
    clearCreateForContent(contentId) {
      setPendingTabCreates((all) => {
        if (!all[contentId]) return all
        const copy = { ...all }
        delete copy[contentId]
        return copy
      })
    },

    isClosing(terminalId) {
      return closingIds().includes(terminalId)
    },
    beginClosing(terminalId) {
      const lifecycle = untrack(() => state.terminal.lifecycle[terminalId])
      const inClosing = untrack(() => closingIds().includes(terminalId))
      if (lifecycle === "closing" && inClosing) return
      if (lifecycle === "closed") return
      transitionLifecycle(terminalId, "closing", "beginClosing")
      setClosingIds((all) => (all.includes(terminalId) ? all : [...all, terminalId]))
    },
    clearClosing(terminalId) {
      const lifecycle = untrack(() => state.terminal.lifecycle[terminalId])
      const inClosing = untrack(() => closingIds().includes(terminalId))
      if (!inClosing && lifecycle !== "closing") return
      if (state.terminal.lifecycle[terminalId] === "closing") {
        transitionLifecycle(terminalId, "closed", "clearClosing")
      }
      setClosingIds((all) =>
        all.includes(terminalId) ? all.filter((item) => item !== terminalId) : all,
      )
    },

    pendingProcessStarts,
    expectProcessPty() {
      setPendingProcessStarts((n) => n + 1)
    },
    resolveProcessPty() {
      setPendingProcessStarts((n) => Math.max(0, n - 1))
    },
    resolveInitialProcessPty() {
      setPendingProcessStarts((n) => Math.max(0, n - 1))
    },
  }
}
