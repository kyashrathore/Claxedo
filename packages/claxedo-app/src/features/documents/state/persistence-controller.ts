import type { RecoveryDraftStore } from "./recovery-draft"

export type PersistenceStatus = "idle" | "dirty" | "saving" | "saved" | "failed" | "conflicted"

export interface DocumentDraft {
  displayName: string
  markdown: string
}

export interface SaveRequest extends DocumentDraft {
  expectedVersion: string
}

export type SaveResponse =
  | { ok: true; version: string }
  | {
      ok: false
      kind: "conflict"
      currentVersion: string
      current: DocumentDraft
    }

export type PersistenceScheduler = (handler: () => void, delay: number) => () => void

export interface PersistenceConflict {
  currentVersion: string
  current: DocumentDraft
  draft: DocumentDraft
}

export interface PersistenceSnapshot {
  status: PersistenceStatus
  documentId: string
  draft: DocumentDraft
  expectedVersion: string
  retryAttempt: number
  retryAt?: number
  error?: unknown
  conflict?: PersistenceConflict
  recoveryError?: unknown
  listenerError?: unknown
  restoredRecoveryDraft: boolean
}

export interface DocumentPersistenceControllerInput {
  document: DocumentDraft & { id: string; version: string }
  save(request: SaveRequest): Promise<SaveResponse>
  recovery: RecoveryDraftStore
  schedule: PersistenceScheduler
  now(): number
  reportError(error: unknown): void
  autosaveDelay?: number
  retryDelays?: readonly number[]
}

export function createDocumentPersistenceController(input: DocumentPersistenceControllerInput) {
  const recovered = input.recovery.read(input.document.id, input.document.version)
  const restored = recovered.ok ? recovered.value : undefined
  const restoredConflict = restored?.version !== undefined && restored.version !== input.document.version
  const listeners = new Set<(snapshot: PersistenceSnapshot) => void>()
  const flushWaiters = new Set<(snapshot: PersistenceSnapshot) => void>()
  const recoveryVersions = new Set(restored ? [restored.version] : [])
  const autosaveDelay = input.autosaveDelay ?? 800
  const retryDelays = input.retryDelays ?? [1_000, 2_000, 4_000]
  const state: PersistenceSnapshot = {
    status: restoredConflict ? "conflicted" : restored ? "dirty" : "idle",
    documentId: input.document.id,
    draft: restored
      ? { displayName: restored.displayName, markdown: restored.markdown }
      : { displayName: input.document.displayName, markdown: input.document.markdown },
    expectedVersion: restored?.version ?? input.document.version,
    retryAttempt: 0,
    restoredRecoveryDraft: Boolean(restored),
    recoveryError: recovered.ok ? undefined : recovered.error,
    conflict:
      restoredConflict && restored
        ? {
            currentVersion: input.document.version,
            current: { displayName: input.document.displayName, markdown: input.document.markdown },
            draft: { displayName: restored.displayName, markdown: restored.markdown },
          }
        : undefined,
  }
  let generation = restored ? 1 : 0
  let savedGeneration = 0
  let saveGeneration = 0
  let saveVersion = state.expectedVersion
  let saveDraft = { ...state.draft }
  let loadedDraft = { displayName: input.document.displayName, markdown: input.document.markdown }
  let saving = false
  let cancelScheduled: (() => void) | undefined

  const snapshot = (): PersistenceSnapshot => ({
    ...state,
    draft: { ...state.draft },
    conflict: state.conflict
      ? {
          currentVersion: state.conflict.currentVersion,
          current: { ...state.conflict.current },
          draft: { ...state.conflict.draft },
        }
      : undefined,
  })

  const reportListenerError = (error: unknown) => {
    state.listenerError = error
    try {
      input.reportError(error)
    } catch (reportError) {
      state.listenerError = reportError
    }
  }

  const notify = () => {
    const current = snapshot()
    listeners.forEach((listener) => {
      try {
        listener(current)
      } catch (error) {
        reportListenerError(error)
      }
    })
  }

  const persistRecoveryDraft = () => {
    const result = input.recovery.write({
      documentId: state.documentId,
      version: state.expectedVersion,
      displayName: state.draft.displayName,
      markdown: state.draft.markdown,
      updatedAt: input.now(),
    })
    if (result.ok) recoveryVersions.add(state.expectedVersion)
    return result.ok ? undefined : result.error
  }

  const removeRecoveryVersions = (versions: readonly string[]) => {
    const results = versions.map((version) => ({ version, result: input.recovery.remove(state.documentId, version) }))
    results.filter((entry) => entry.result.ok).forEach((entry) => recoveryVersions.delete(entry.version))
    return results.flatMap((entry) => (entry.result.ok ? [] : [entry.result.error]))[0]
  }

  const cancelTimer = () => {
    cancelScheduled?.()
    cancelScheduled = undefined
  }

  const settleFlushes = () => {
    if (!flushWaiters.size) return
    const current = snapshot()
    flushWaiters.forEach((resolve) => resolve(current))
    flushWaiters.clear()
  }

  const scheduleSave = (delay: number) => {
    cancelTimer()
    cancelScheduled = input.schedule(() => {
      cancelScheduled = undefined
      startSave()
    }, delay)
  }

  const saveFailed = (error: unknown) => {
    saving = false
    if (state.conflict) {
      state.error = error
      settleFlushes()
      notify()
      return
    }
    state.status = "failed"
    state.error = error
    state.retryAttempt++
    const delay = retryDelays[state.retryAttempt - 1]
    state.retryAt = delay === undefined ? undefined : input.now() + delay
    if (delay !== undefined) scheduleSave(delay)
    settleFlushes()
    notify()
  }

  const saveCompleted = (response: SaveResponse) => {
    saving = false
    if (state.conflict) {
      const matchesCompletedSave =
        response.ok &&
        response.version === state.conflict.currentVersion &&
        saveDraft.displayName === state.conflict.current.displayName &&
        saveDraft.markdown === state.conflict.current.markdown
      if (!matchesCompletedSave) {
        state.error = undefined
        settleFlushes()
        notify()
        return
      }
      state.conflict = undefined
    }
    if (!response.ok) {
      state.status = "conflicted"
      state.conflict = {
        currentVersion: response.currentVersion,
        current: { ...response.current },
        draft: { ...state.draft },
      }
      state.error = undefined
      state.retryAt = undefined
      cancelTimer()
      settleFlushes()
      notify()
      return
    }

    const previousVersion = saveVersion
    state.expectedVersion = response.version
    loadedDraft = { ...saveDraft }
    savedGeneration = saveGeneration
    state.retryAttempt = 0
    state.retryAt = undefined
    state.error = undefined
    state.conflict = undefined
    const recoveryRemovalError = removeRecoveryVersions(
      generation > savedGeneration ? [previousVersion] : [...recoveryVersions],
    )

    if (generation > savedGeneration) {
      state.status = "dirty"
      state.recoveryError = persistRecoveryDraft() ?? recoveryRemovalError
      notify()
      startSave()
      return
    }

    state.status = "saved"
    state.recoveryError = recoveryRemovalError
    state.restoredRecoveryDraft = false
    settleFlushes()
    notify()
  }

  function startSave() {
    if (saving || state.status === "conflicted" || generation <= savedGeneration) {
      if (!saving && generation <= savedGeneration) settleFlushes()
      return
    }
    cancelTimer()
    saving = true
    saveGeneration = generation
    saveVersion = state.expectedVersion
    saveDraft = {
      displayName: state.draft.displayName,
      markdown: state.draft.markdown,
    }
    const request = {
      ...saveDraft,
      expectedVersion: saveVersion,
    }
    state.status = "saving"
    state.retryAt = undefined
    state.error = undefined
    notify()
    Promise.resolve()
      .then(() => input.save(request))
      .then(saveCompleted, saveFailed)
  }

  const edit = (draft: DocumentDraft) => {
    generation++
    state.draft = { ...draft }
    state.error = undefined
    state.retryAt = undefined
    state.retryAttempt = 0
    state.recoveryError = persistRecoveryDraft()
    if (state.status === "conflicted") {
      state.conflict = state.conflict ? { ...state.conflict, draft: { ...draft } } : undefined
      notify()
      return
    }
    state.status = saving ? "saving" : "dirty"
    cancelTimer()
    if (!saving) scheduleSave(autosaveDelay)
    notify()
  }

  const flush = () => {
    cancelTimer()
    if (state.status === "conflicted" || (!saving && generation <= savedGeneration)) {
      return Promise.resolve(snapshot())
    }
    const settled = new Promise<PersistenceSnapshot>((resolve) => flushWaiters.add(resolve))
    if (!saving) startSave()
    return settled
  }

  if (restored && !restoredConflict) scheduleSave(autosaveDelay)

  return {
    snapshot,
    subscribe(listener: (snapshot: PersistenceSnapshot) => void) {
      listeners.add(listener)
      try {
        listener(snapshot())
      } catch (error) {
        reportListenerError(error)
      }
      return () => listeners.delete(listener)
    },
    editDisplayName(displayName: string) {
      edit({ ...state.draft, displayName })
    },
    editMarkdown(markdown: string) {
      edit({ ...state.draft, markdown })
    },
    edit,
    flush,
    flushOnBlur: flush,
    flushOnClose: flush,
    flushBeforeAction: flush,
    applyExternalChange(current: DocumentDraft & { version: string }) {
      const loaded = state.conflict
        ? {
            version: state.conflict.currentVersion,
            draft: state.conflict.current,
          }
        : { version: state.expectedVersion, draft: loadedDraft }
      if (current.displayName === loaded.draft.displayName && current.markdown === loaded.draft.markdown) {
        if (current.version === loaded.version) return snapshot()
        if (state.conflict) {
          state.conflict = { ...state.conflict, currentVersion: current.version }
          notify()
          return snapshot()
        }
        const previousVersion = state.expectedVersion
        state.expectedVersion = current.version
        if (generation > savedGeneration || state.status === "failed") {
          state.recoveryError = persistRecoveryDraft() ?? removeRecoveryVersions([previousVersion])
        }
        notify()
        return snapshot()
      }
      if (saving || generation > savedGeneration || state.status === "failed" || state.status === "conflicted") {
        cancelTimer()
        state.status = "conflicted"
        state.conflict = {
          currentVersion: current.version,
          current: { displayName: current.displayName, markdown: current.markdown },
          draft: { ...state.draft },
        }
        state.retryAt = undefined
        notify()
        return snapshot()
      }
      state.status = "idle"
      state.draft = { displayName: current.displayName, markdown: current.markdown }
      loadedDraft = { displayName: current.displayName, markdown: current.markdown }
      state.expectedVersion = current.version
      state.error = undefined
      state.conflict = undefined
      state.retryAttempt = 0
      state.retryAt = undefined
      state.restoredRecoveryDraft = false
      notify()
      return snapshot()
    },
    retry() {
      if (state.status !== "failed") return Promise.resolve(snapshot())
      state.retryAttempt = 0
      state.retryAt = undefined
      state.status = "dirty"
      notify()
      return flush()
    },
    draftForSaveAsCopy() {
      if (state.status !== "conflicted") return undefined
      return { ...state.draft }
    },
    reloadFromConflict() {
      if (!state.conflict) return snapshot()
      const conflict = state.conflict
      const previousVersion = state.expectedVersion
      generation = 0
      savedGeneration = 0
      state.status = "idle"
      state.draft = { ...conflict.current }
      loadedDraft = { ...conflict.current }
      state.expectedVersion = conflict.currentVersion
      state.conflict = undefined
      state.error = undefined
      state.retryAttempt = 0
      state.retryAt = undefined
      state.restoredRecoveryDraft = false
      state.recoveryError = removeRecoveryVersions([...recoveryVersions, previousVersion])
      notify()
      return snapshot()
    },
    confirmOverwrite() {
      if (!state.conflict) return Promise.resolve(snapshot())
      loadedDraft = { ...state.conflict.current }
      state.expectedVersion = state.conflict.currentVersion
      state.conflict = undefined
      state.status = "dirty"
      state.retryAttempt = 0
      state.recoveryError = persistRecoveryDraft()
      notify()
      return flush()
    },
  }
}

export type DocumentPersistenceController = ReturnType<typeof createDocumentPersistenceController>
