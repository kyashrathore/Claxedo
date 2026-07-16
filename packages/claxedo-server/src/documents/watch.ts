import fs from "node:fs"
import path from "node:path"
import { DocumentNotFoundError } from "./errors"
import type { DocumentActor, DocumentHandle, DocumentRead, DocumentVersion, SnapshotRef } from "./port"
import { documentVersionsMatch } from "./version"

export type WatchableDocumentHandle = DocumentHandle & Readonly<{ canonicalPath: string }>

export type DocumentExternalChange =
  | Readonly<{
      type: "changed"
      documentId: string
      projectId: string
      previousVersion: DocumentVersion
      currentVersion: DocumentVersion
    }>
  | Readonly<{
      type: "missing"
      documentId: string
      projectId: string
      previousVersion: DocumentVersion
      currentVersion: null
    }>

type WatchRegistration = Readonly<{
  close(): void
}>

type WatchFactory = (target: string, change: () => void, error: (error: unknown) => void) => WatchRegistration

type State<H extends WatchableDocumentHandle> = {
  handle: H
  version: DocumentVersion
  references: number
  listeners: Set<(change: DocumentExternalChange) => void | Promise<void>>
  watcher: WatchRegistration
  cancel?: () => void
  generation: number
  missing: boolean
  refreshing: boolean
  refreshAgain: boolean
}

const watcherActor = { type: "system", id: "document_watcher" } satisfies DocumentActor

export function createDocumentWatchService<H extends WatchableDocumentHandle>(
  options: Readonly<{
    read(handle: H): Promise<DocumentRead>
    snapshot(handle: H, request: Readonly<{ reason: string; actor: DocumentActor }>): Promise<SnapshotRef>
    onChange(change: DocumentExternalChange): void | Promise<void>
    onError(error: unknown, handle: H): void
    watch?: WatchFactory
    schedule?: (run: () => void | Promise<void>, delay: number) => () => void
    debounceMs?: number
  }>,
) {
  const states = new Map<string, State<H>>()
  const watch = options.watch ?? watchDirectory
  const schedule =
    options.schedule ??
    ((run, delay) => {
      const timer = setTimeout(() => void run(), delay)
      timer.unref()
      return () => clearTimeout(timer)
    })

  return {
    open(
      handle: H,
      loadedVersion: DocumentVersion,
      onChange?: (change: DocumentExternalChange) => void | Promise<void>,
    ) {
      const current = states.get(handle.documentId)
      if (current) {
        current.references++
        if (onChange) current.listeners.add(onChange)
        return registration(current, onChange)
      }
      const state = {
        handle,
        version: loadedVersion,
        references: 1,
        listeners: new Set(onChange ? [onChange] : []),
        generation: 0,
        missing: false,
        refreshing: false,
        refreshAgain: false,
      } as State<H>
      state.watcher = watch(
        handle.canonicalPath,
        () => enqueue(state),
        (error) => report(error, state.handle),
      )
      states.set(handle.documentId, state)
      enqueue(state, 0)
      return registration(state, onChange)
    },

    active() {
      return [...states.keys()].sort()
    },

    close() {
      states.forEach((state) => close(state))
    },
  }

  function registration(
    state: State<H>,
    onChange?: (change: DocumentExternalChange) => void | Promise<void>,
  ) {
    let closed = false
    return {
      close() {
        if (closed) return
        closed = true
        if (onChange) state.listeners.delete(onChange)
        state.references--
        if (state.references === 0) close(state)
      },
    }
  }

  function enqueue(state: State<H>, delay = options.debounceMs ?? 100) {
    state.generation++
    const generation = state.generation
    state.cancel?.()
    state.cancel = schedule(async () => {
      if (states.get(state.handle.documentId) !== state || generation !== state.generation) return
      state.cancel = undefined
      if (state.refreshing) {
        state.refreshAgain = true
        return
      }
      state.refreshing = true
      try {
        do {
          state.refreshAgain = false
          await refresh(state)
        } while (state.refreshAgain && states.get(state.handle.documentId) === state)
      } catch (error) {
        report(error, state.handle)
      } finally {
        state.refreshing = false
      }
    }, delay)
  }

  async function refresh(state: State<H>) {
    const current = await readCurrent(state)
    if (states.get(state.handle.documentId) !== state) return
    if (!current) {
      if (state.missing) return
      state.missing = true
      await publish(state, {
        type: "missing",
        documentId: state.handle.documentId,
        projectId: state.handle.projectId,
        previousVersion: state.version,
        currentVersion: null,
      })
      return
    }
    const reappeared = state.missing
    state.missing = false
    if (!reappeared && documentVersionsMatch(current.version, state.version)) return
    const previousVersion = state.version
    try {
      await options.snapshot(state.handle, { reason: "document.external_change", actor: watcherActor })
    } catch (error) {
      report(error, state.handle)
    }
    const confirmed = await readCurrent(state)
    if (
      states.get(state.handle.documentId) !== state ||
      !confirmed ||
      !documentVersionsMatch(confirmed.version, current.version)
    ) {
      state.refreshAgain = true
      return
    }
    state.version = current.version
    await publish(state, {
      type: "changed",
      documentId: state.handle.documentId,
      projectId: state.handle.projectId,
      previousVersion,
      currentVersion: current.version,
    })
  }

  async function readCurrent(state: State<H>) {
    return await options.read(state.handle).catch((error: unknown) => {
      if (!(error instanceof DocumentNotFoundError)) throw error
      return undefined
    })
  }

  async function publish(state: State<H>, change: DocumentExternalChange) {
    await options.onChange(change)
    await Promise.all([...state.listeners].map((listener) => listener(change)))
  }

  function report(error: unknown, handle: H) {
    try {
      options.onError(error, handle)
    } catch (reportError) {
      console.error(`[document-watch] failed to report ${handle.documentId}:`, reportError)
    }
  }

  function close(state: State<H>) {
    if (states.get(state.handle.documentId) !== state) return
    states.delete(state.handle.documentId)
    state.cancel?.()
    state.watcher.close()
  }
}

function watchDirectory(target: string, change: () => void, error: (error: unknown) => void) {
  const name = path.basename(target)
  const watcher = fs.watch(path.dirname(target), { persistent: false }, (_event, filename) => {
    if (filename === null || filename.toString() === name) change()
  })
  watcher.on("error", error)
  return { close: () => watcher.close() }
}
