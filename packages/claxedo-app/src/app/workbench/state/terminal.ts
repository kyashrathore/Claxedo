import { storePath } from "solid-js"
// Terminal slice — owner / agentStatus / agentSeen / lifecycle.
//
// Transient signals for pending terminal actions stay encapsulated here as
// createSignal-backed locals. They are not part of the persisted ClaxedoState
// and callers never read them across reloads.

import { createSignal, onCleanup, untrack } from "solid-js"
import type { StoreSetter } from "solid-js"
import { createStagedMap, STAGED_DELETE, type StagedMap } from "@/lib/staged-reads"
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
  /** Reactive PTY ids owned by one content id; unrelated owners do not invalidate this accessor. */
  ownedIds(contentId: string): readonly string[]
  /** Mark a content as the owner of a terminal. */
  own(contentId: string, terminalId: string): void
  disown(terminalId: string): void
  /** PTY ids currently owned by a process (`process:*`). */
  processOwnedPtyIds(): string[]

  lifecycle(terminalId: string): TerminalLifecycleState | undefined
  transitionLifecycle(terminalId: string, next: TerminalLifecycleState, reason?: string): boolean

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
  setState: StoreSetter<ClaxedoState>
}): TerminalSliceApi {
  const { state, setState } = input

  // Same-task read-your-writes for the per-terminal maps. Solid 2 stages store
  // writes until flush, but orchestration reads terminal ownership right after
  // assigning it (openTerminal -> own, closeContent -> owner/clearForContent).
  // The shared overlay in `@/lib/staged-reads` closes that gap without changing
  // reactive tracking — reads still hit the store first — and documents why
  // Solid 2's own write-callback draft cannot serve this shape.
  const overlay = {
    owner: createStagedMap<string>(),
    agentStatus: createStagedMap<TerminalAgentStatus>(),
    agentSeen: createStagedMap<boolean>(),
    lifecycle: createStagedMap<TerminalLifecycleState>(),
  }
  type TerminalMap = keyof typeof overlay
  /** Stage a value, or STAGED_DELETE for a same-task removal. */
  const stage = <M extends TerminalMap>(map: M, terminalId: string, value: unknown) =>
    overlay[map].stage(terminalId, (value === undefined ? STAGED_DELETE : value) as never)
  const staged = <T>(map: TerminalMap, terminalId: string, committed: T): T =>
    (overlay[map] as StagedMap<unknown>).read(terminalId, committed) as T
  /** Entries of one map with the staged overlay applied. */
  const entriesOf = (map: TerminalMap): Array<[string, unknown]> =>
    (overlay[map] as StagedMap<unknown>).entries(state.terminal[map] as Record<string, unknown>)
  const ownerOf = (terminalId: string): string | undefined =>
    staged("owner", terminalId, state.terminal.owner[terminalId])
  const stageOwner = (terminalId: string, contentId: string | undefined) => stage("owner", terminalId, contentId)
  const ownerEntries = (): Array<[string, string]> =>
    entriesOf("owner").filter((entry): entry is [string, string] => typeof entry[1] === "string")

  // ── transient signals ─────────────────────────────────────────────────
  const [pendingTabCreates, setPendingTabCreates] = createSignal<Record<string, PendingTabTerminalCreate>>({})
  const [closingIds, setClosingIds] = createSignal<string[]>([])
  // See old terminal.ts: start at 1 so process PTYs arriving before
  // ProcessPaneProvider mounts don't get auto-tabbed.
  const [pendingProcessStarts, setPendingProcessStarts] = createSignal(1)
  // `terminal.owner` is keyed by PTY id, but the hot UI lookup goes the other
  // direction: when focus changes, clear attention for the newly focused
  // content. Scanning the whole owner object made every session switch O(all
  // terminals). Keep that reverse relation here, beside the authoritative
  // owner mutations, with one signal per content id so an ownership change in
  // another content cannot wake the focused-content observer.
  const ownedIdsByContent = new Map<string, readonly string[]>()
  const ownedIdSignals = new Map<string, ReturnType<typeof createSignal<readonly string[]>>>()
  for (const [terminalId, contentId] of Object.entries(state.terminal.owner)) {
    if (!contentId) continue
    ownedIdsByContent.set(contentId, [...(ownedIdsByContent.get(contentId) ?? []), terminalId])
  }
  const ownedIdSignal = (contentId: string) => {
    const existing = ownedIdSignals.get(contentId)
    if (existing) return existing
    const created = createSignal<readonly string[]>(ownedIdsByContent.get(contentId) ?? [])
    ownedIdSignals.set(contentId, created)
    return created
  }
  const replaceOwnedIds = (contentId: string, next: readonly string[]) => {
    if (next.length === 0) ownedIdsByContent.delete(contentId)
    else ownedIdsByContent.set(contentId, next)
    ownedIdSignals.get(contentId)?.[1](next)
  }
  const updateOwnerIndex = (
    terminalId: string,
    previousContentId: string | undefined,
    nextContentId: string | undefined,
  ) => {
    if (previousContentId === nextContentId) return
    if (previousContentId) {
      replaceOwnedIds(
        previousContentId,
        (ownedIdsByContent.get(previousContentId) ?? []).filter((id) => id !== terminalId),
      )
    }
    if (nextContentId) {
      const current = ownedIdsByContent.get(nextContentId) ?? []
      if (!current.includes(terminalId)) replaceOwnedIds(nextContentId, [...current, terminalId])
    }
  }
  // Collapse the initial reservation to 0 once the ProcessPaneProvider has had
  // time to mount (any real process PTY it owns will have bumped the counter by
  // now). Tie the timer to the owning reactive scope so repeated
  // mount/unmount (tests, hot reload) don't leak a timer firing against a stale
  // signal closure.
  const initialProcessStartTimer = setTimeout(() => {
    setPendingProcessStarts((n) => (n === 1 ? 0 : n))
  }, 15_000)
  onCleanup(() => clearTimeout(initialProcessStartTimer))

  const lifecycleOf = (terminalId: string): TerminalLifecycleState | undefined =>
    staged("lifecycle", terminalId, state.terminal.lifecycle[terminalId])

  const transitionLifecycle = (id: string, next: TerminalLifecycleState, _reason?: string): boolean => {
    // Through the overlay, like every other read in this slice: a burst of
    // terminal events lands in ONE task (create + attach, close + reopen), and
    // Solid 2 stages each write until the scheduler flushes. Reading the
    // committed map here saw `undefined` for a terminal this task had already
    // moved, so the "any first hop" branch was taken every time and the
    // transition table stopped rejecting anything.
    const current = lifecycleOf(id)
    if (current === next) return true
    const allowed =
      current === undefined
        ? new Set<TerminalLifecycleState>(["creating", "attaching", "attached", "closing", "closed"])
        : lifecycleTransition[current]
    if (allowed.has(next)) {
      stage("lifecycle", id, next)
      setState(storePath("terminal", "lifecycle", id, next))
      return true
    }
    return false
  }

  return {
    agentStatus(terminalId) {
      return staged("agentStatus", terminalId, state.terminal.agentStatus[terminalId]) ?? "idle"
    },
    isTracked(terminalId) {
      return staged("agentStatus", terminalId, state.terminal.agentStatus[terminalId]) !== undefined
    },
    setAgentStatus(terminalId, status) {
      stage("agentStatus", terminalId, status)
      setState(storePath("terminal", "agentStatus", terminalId, status))
      if (status !== "idle") {
        stage("agentSeen", terminalId, true)
        setState(storePath("terminal", "agentSeen", terminalId, true))
      }
    },
    clearAgentStatus(terminalId) {
      stage("agentStatus", terminalId, undefined)
      setState(storePath("terminal", "agentStatus", terminalId, undefined))
    },
    seen(terminalId) {
      return !!staged("agentSeen", terminalId, state.terminal.agentSeen[terminalId])
    },
    clearSeen(terminalId) {
      stage("agentSeen", terminalId, undefined)
      setState(storePath("terminal", "agentSeen", terminalId, undefined))
    },
    resetAllAgentStatuses() {
      for (const [id] of entriesOf("agentStatus")) {
        stage("agentStatus", id, undefined)
        setState(storePath("terminal", "agentStatus", id, undefined))
      }
      for (const [id] of entriesOf("agentSeen")) {
        stage("agentSeen", id, undefined)
        setState(storePath("terminal", "agentSeen", id, undefined))
      }
    },

    owner(terminalId) {
      return ownerOf(terminalId)
    },
    ownedIds(contentId) {
      return ownedIdSignal(contentId)[0]()
    },
    own(contentId, terminalId) {
      // `ownerOf`, not the committed map: an ownership change staged earlier in
      // this task must be visible or the no-op guard misfires and the reverse
      // index is walked with the wrong previous owner.
      const previous = ownerOf(terminalId)
      if (previous === contentId) return
      stageOwner(terminalId, contentId)
      setState(storePath("terminal", "owner", terminalId, contentId))
      updateOwnerIndex(terminalId, previous, contentId)
    },
    disown(terminalId) {
      const previous = ownerOf(terminalId)
      if (!previous) return
      stageOwner(terminalId, undefined)
      setState(storePath("terminal", "owner", terminalId, undefined))
      updateOwnerIndex(terminalId, previous, undefined)
    },
    processOwnedPtyIds() {
      return ownerEntries()
        .filter(([, v]) => v.startsWith("process:"))
        .map(([k]) => k)
    },

    lifecycle(terminalId) {
      return lifecycleOf(terminalId)
    },
    transitionLifecycle,

    clearForContent(contentId) {
      // The reverse index answers this directly, so closing one content costs
      // O(its terminals) instead of a scan of every terminal's owner entry. It
      // is maintained eagerly at each ownership write, so it already reflects
      // this task's staged changes.
      const owned = [...(ownedIdsByContent.get(contentId) ?? [])]
      for (const id of owned) {
        stageOwner(id, undefined)
        stage("agentStatus", id, undefined)
        stage("agentSeen", id, undefined)
        stage("lifecycle", id, "closing")
        setState(storePath("terminal", "owner", id, undefined))
        setState(storePath("terminal", "agentStatus", id, undefined))
        setState(storePath("terminal", "agentSeen", id, undefined))
        setState(storePath("terminal", "lifecycle", id, "closing"))
        updateOwnerIndex(id, contentId, undefined)
      }
    },

    replaceId(oldId, newId) {
      const ownerVal = ownerOf(oldId)
      if (ownerVal !== undefined) {
        const replacedOwner = ownerOf(newId)
        stageOwner(newId, ownerVal)
        stageOwner(oldId, undefined)
        setState(storePath("terminal", "owner", newId, ownerVal))
        setState(storePath("terminal", "owner", oldId, undefined))
        updateOwnerIndex(newId, replacedOwner, ownerVal)
        updateOwnerIndex(oldId, ownerVal, undefined)
      }
      // Overlay reads and writes, for the same reason as `transitionLifecycle`:
      // a provisional id is replaced by the server id in the same task the
      // terminal was first recorded in, so committed reads found nothing to
      // carry over and the rename silently dropped lifecycle and agent state.
      const lifecycleVal = lifecycleOf(oldId)
      if (lifecycleVal !== undefined) {
        stage("lifecycle", newId, lifecycleVal)
        stage("lifecycle", oldId, undefined)
        setState(storePath("terminal", "lifecycle", newId, lifecycleVal))
        setState(storePath("terminal", "lifecycle", oldId, undefined))
      }
      const statusVal = staged("agentStatus", oldId, state.terminal.agentStatus[oldId])
      if (statusVal !== undefined) {
        stage("agentStatus", newId, statusVal)
        stage("agentStatus", oldId, undefined)
        setState(storePath("terminal", "agentStatus", newId, statusVal))
        setState(storePath("terminal", "agentStatus", oldId, undefined))
      }
      const seenVal = staged("agentSeen", oldId, state.terminal.agentSeen[oldId])
      if (seenVal !== undefined) {
        stage("agentSeen", newId, seenVal)
        stage("agentSeen", oldId, undefined)
        setState(storePath("terminal", "agentSeen", newId, seenVal))
        setState(storePath("terminal", "agentSeen", oldId, undefined))
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
      setClosingIds((all) => (all.includes(terminalId) ? all.filter((item) => item !== terminalId) : all))
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
