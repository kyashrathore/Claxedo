import type { PersistenceConflict } from "@/features/documents/state/persistence-controller"

export function ConflictRecovery(props: {
  conflict: PersistenceConflict
  onReload: () => void
  onSaveCopy: () => void
  onOverwrite: () => void
}) {
  return (
    <section
      class="border-t border-border-critical-base bg-surface-critical-base/10 px-6 py-4"
      aria-labelledby="document-conflict-title"
      role="alert"
    >
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="document-conflict-title" class="text-sm font-medium text-text-strong">
            Document changed on disk
          </h2>
          <p class="mt-1 text-xs text-text-weak">
            Your draft is preserved. Compare both versions before choosing a recovery action.
          </p>
        </div>
        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            class="rounded px-2 py-1 text-xs hover:bg-surface-raised-base focus-visible:outline focus-visible:outline-2"
            onClick={props.onReload}
          >
            Reload disk
          </button>
          <button
            type="button"
            class="rounded px-2 py-1 text-xs hover:bg-surface-raised-base focus-visible:outline focus-visible:outline-2"
            onClick={props.onSaveCopy}
          >
            Save as copy
          </button>
          <button
            type="button"
            class="rounded bg-surface-critical-base px-2 py-1 text-xs text-text-on-critical-base focus-visible:outline focus-visible:outline-2"
            onClick={props.onOverwrite}
          >
            Overwrite
          </button>
        </div>
      </div>
      <details class="mt-3 text-xs">
        <summary class="cursor-pointer text-text-strong">Compare versions</summary>
        <div class="mt-2 grid gap-3 md:grid-cols-2">
          <pre
            class="max-h-48 overflow-auto whitespace-pre-wrap rounded border border-border-weak-base bg-background-base p-3"
            aria-label="Your draft"
          >
            {props.conflict.draft.markdown}
          </pre>
          <pre
            class="max-h-48 overflow-auto whitespace-pre-wrap rounded border border-border-weak-base bg-background-base p-3"
            aria-label="Current disk version"
          >
            {props.conflict.current.markdown}
          </pre>
        </div>
      </details>
    </section>
  )
}
