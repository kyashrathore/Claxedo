import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { Popover } from "@opencode-ai/ui/popover"
import { For, Show, createSignal } from "solid-js"
import { useLanguage } from "@/platform/i18n/provider"
import { getRelativeTime } from "@/lib/time"
import type { DocumentSnapshot } from "../data/documents-api"

const actorLabels = { user: "You", agent: "Agent", system: "System" } as const

const actionLabels: Record<string, string> = {
  "document.created": "Created",
  "document.before_write": "Before edit",
  "document.written": "Edited",
  "document.before_restore": "Before restore",
}

// Snapshot reasons are machine codes; show words. Unmapped codes stay raw rather than
// get flattened into a wrong label — restoring the wrong version is unrecoverable.
function actionLabel(reason: string) {
  if (reason.startsWith("document.restored:")) return "Restored"
  return actionLabels[reason] ?? reason
}

export function VersionHistory(props: {
  list: () => Promise<DocumentSnapshot[]>
  restore: (snapshotId: string) => Promise<void>
  reportError: (error: unknown) => void
}) {
  const language = useLanguage()
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
    <Popover
      title="Version history"
      class="w-72 text-xs text-text-weak"
      triggerAs="button"
      triggerProps={{
        type: "button",
        "aria-label": "More",
        title: "More",
        class:
          "flex size-7 items-center justify-center rounded text-icon-weak-base hover:bg-surface-raised-base focus-visible:outline focus-visible:outline-2",
      }}
      trigger={<Icon name="dot-grid" size="small" />}
      onOpenChange={(open) => {
        if (open && !snapshots().length) void load()
      }}
    >
      <div>
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
                  <li class="flex items-center justify-between gap-3 border-b border-border-weak-base pb-2">
                    <span class="min-w-0">
                      <span class="block truncate text-text-strong">
                        {actorLabels[snapshot.actor.type]} · {actionLabel(snapshot.reason)}
                      </span>
                      <span class="block" title={new Date(snapshot.createdAt).toLocaleString()}>
                        {getRelativeTime(new Date(snapshot.createdAt).toISOString(), language.t)}
                      </span>
                    </span>
                    <button
                      type="button"
                      class="shrink-0 rounded px-2 py-1 text-text-strong hover:bg-surface-raised-base disabled:text-text-weak"
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
    </Popover>
  )
}
