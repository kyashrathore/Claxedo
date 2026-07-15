import type { ChangeCursor } from "@claxedo/workgraph/contracts"
import { createEffect, createSignal, onCleanup, onMount, type Accessor } from "solid-js"
import type { WorkGraphApiError, WorkGraphClient } from "./api"
import { runWorkGraphSync, WORKGRAPH_CHANGE_WAIT_MS } from "./change-sync"

export function useWorkGraphSyncLifecycle(input: {
  active: Accessor<boolean>
  snapshot: Accessor<{ snapshotCursor?: ChangeCursor } | undefined>
  changes: WorkGraphClient["changes"]
  reload: () => Promise<ChangeCursor | undefined>
}) {
  const [error, setError] = createSignal<WorkGraphApiError>()
  const [documentVisible, setDocumentVisible] = createSignal(
    typeof document === "undefined" || document.visibilityState !== "hidden",
  )
  let controller: AbortController | undefined
  let cursor: ChangeCursor | undefined

  const stop = () => {
    controller?.abort()
    controller = undefined
  }
  const start = (nextCursor: ChangeCursor | undefined) => {
    stop()
    cursor = nextCursor
    const next = new AbortController()
    controller = next
    void runWorkGraphSync({
      changes: input.changes,
      cursor,
      signal: next.signal,
      waitMs: WORKGRAPH_CHANGE_WAIT_MS,
      reload: input.reload,
      onAdvance: (value) => {
        cursor = value
      },
      onError: (value) => {
        controller = undefined
        setError(value)
      },
    })
  }

  onMount(() => {
    if (typeof document === "undefined") return
    const updateVisibility = () => setDocumentVisible(document.visibilityState !== "hidden")
    document.addEventListener("visibilitychange", updateVisibility)
    onCleanup(() => document.removeEventListener("visibilitychange", updateVisibility))
  })
  createEffect(() => {
    const snapshot = input.snapshot()
    if (!input.active() || !documentVisible()) {
      stop()
      return
    }
    if (!snapshot || controller || error()) return
    start(cursor ?? snapshot.snapshotCursor)
  })
  onCleanup(stop)

  return {
    error,
    retry: () => {
      stop()
      setError(undefined)
    },
  }
}
