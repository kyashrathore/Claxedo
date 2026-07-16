import type { DocumentEvent, DocumentQuery } from "../data/documents-api"

export type ExternalDocument = Readonly<{
  displayName: string
  markdown: string
  version: string
}>

export function createDocumentExternalChangeController(
  options: Readonly<{
    documentId: string
    projectId: string
    watch(query: DocumentQuery, onEvent: (event: DocumentEvent) => void, signal: AbortSignal): Promise<void>
    read(): Promise<ExternalDocument>
    apply(current: ExternalDocument): void
    onUnavailable(error: unknown): void
    onError(error: unknown): void
    isUnavailable?(error: unknown): boolean
    schedule(run: () => void, delay: number): () => void
    subscribeFocus(refresh: () => void): () => void
  }>,
) {
  let stopped = true
  let refreshing = false
  let refreshAgain = false
  let retryAttempt = 0
  let abort: AbortController | undefined
  let cancelRetry: (() => void) | undefined
  let unsubscribeFocus: (() => void) | undefined
  let epoch = 0

  const active = (run: number) => !stopped && run === epoch

  const refresh = () => {
    if (stopped) return
    if (refreshing) {
      refreshAgain = true
      return
    }
    refreshing = true
    const run = epoch
    void options
      .read()
      .then(
        (current) => {
          if (active(run)) options.apply(current)
        },
        (error) => {
          if (!active(run)) return
          if (options.isUnavailable?.(error)) {
            options.onUnavailable(error)
            return
          }
          options.onError(error)
        },
      )
      .finally(() => {
        refreshing = false
        if (stopped) {
          refreshAgain = false
          return
        }
        if (!refreshAgain && run === epoch) return
        refreshAgain = false
        refresh()
      })
  }

  const reconnect = (error: unknown, run: number, connection: AbortController) => {
    if (!active(run) || abort !== connection || connection.signal.aborted) return
    options.onError(error)
    cancelRetry?.()
    cancelRetry = options.schedule(
      () => {
        if (active(run)) connect()
      },
      Math.min(1_000 * 2 ** retryAttempt++, 8_000),
    )
  }

  function connect() {
    if (stopped) return
    const run = epoch
    const connection = new AbortController()
    abort = connection
    void options
      .watch(
        { projectId: options.projectId, documentId: options.documentId },
        (event) => {
          if (!active(run)) return
          if (event.type === "document.connected") {
            retryAttempt = 0
            // The server establishes its watcher baseline independently from
            // the editor's initial read. Re-read on every handshake so an
            // edit between those two operations cannot disappear.
            refresh()
            return
          }
          if (event.type === "document.changed" && event.document_id === options.documentId) refresh()
        },
        connection.signal,
      )
      .then(
        () => reconnect(new Error("Document event stream closed."), run, connection),
        (error) => reconnect(error, run, connection),
      )
  }

  return {
    start() {
      if (!stopped) return
      stopped = false
      epoch++
      unsubscribeFocus = options.subscribeFocus(refresh)
      refresh()
      connect()
    },
    refresh,
    stop() {
      if (stopped) return
      stopped = true
      epoch++
      refreshAgain = false
      abort?.abort()
      cancelRetry?.()
      unsubscribeFocus?.()
    },
  }
}
