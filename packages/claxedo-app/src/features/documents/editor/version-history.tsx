import { For, Show, createSignal } from "solid-js"
import type { DocumentSnapshot } from "../data/documents-api"

export function VersionHistory(props: {
  list: () => Promise<DocumentSnapshot[]>
  restore: (snapshotId: string) => Promise<void>
  reportError: (error: unknown) => void
}) {
  const [snapshots, setSnapshots] = createSignal<DocumentSnapshot[]>([])
  const [loading, setLoading] = createSignal(false)
  const [restoring, setRestoring] = createSignal<string>()
  const [error, setError] = createSignal<string>()

  const load = async () => {
    if (loading()) return
    setLoading(true)
    setError(undefined)
    try {
      setSnapshots(await props.list())
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next))
      props.reportError(next)
    }
    setLoading(false)
  }

  const restore = async (snapshotId: string) => {
    setRestoring(snapshotId)
    setError(undefined)
    try {
      await props.restore(snapshotId)
      await load()
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next))
      props.reportError(next)
    }
    setRestoring(undefined)
  }

  return (
    <details
      class="relative text-xs text-text-weak"
      onToggle={(event) => {
        if (event.currentTarget.open && !snapshots().length) void load()
      }}
    >
      <summary class="cursor-pointer rounded px-2 py-1 hover:bg-surface-raised-base focus-visible:outline focus-visible:outline-2">
        Version history
      </summary>
      <div class="absolute right-0 z-30 mt-1 w-80 rounded border border-border-weak-base bg-background-base p-3 shadow-lg">
        <Show when={error()}>
          {(message) => (
            <p class="mb-2 text-text-on-critical-base" role="alert">
              {message()}
            </p>
          )}
        </Show>
        <Show when={!loading()} fallback={<p role="status">Loading versions…</p>}>
          <Show when={snapshots().length} fallback={<p>No saved versions yet.</p>}>
            <ul class="max-h-64 space-y-2 overflow-auto" aria-label="Document versions">
              <For each={snapshots()}>
                {(snapshot) => (
                  <li class="flex items-start justify-between gap-3 border-b border-border-weak-base pb-2">
                    <span class="min-w-0">
                      <span class="block truncate text-text-strong">{snapshot.reason}</span>
                      <span class="block">{new Date(snapshot.createdAt).toLocaleString()}</span>
                    </span>
                    <button
                      type="button"
                      class="rounded px-2 py-1 text-text-strong hover:bg-surface-raised-base disabled:text-text-weak"
                      disabled={Boolean(restoring())}
                      onClick={() => void restore(snapshot.id)}
                    >
                      {restoring() === snapshot.id ? "Restoring…" : "Restore"}
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </div>
    </details>
  )
}
