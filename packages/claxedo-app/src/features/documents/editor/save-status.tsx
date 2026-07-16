import type { PersistenceSnapshot } from "@/features/documents/state/persistence-controller"

const labels = {
  idle: "Ready",
  dirty: "Unsaved changes",
  saving: "Saving…",
  saved: "Saved",
  failed: "Save failed",
  conflicted: "Conflict",
} as const

export function SaveStatus(props: { snapshot: PersistenceSnapshot; onRetry: () => void }) {
  return (
    <div
      class="flex min-h-7 items-center gap-2 text-xs text-text-weak"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span
        classList={{
          "text-text-on-critical-base": props.snapshot.status === "failed" || props.snapshot.status === "conflicted",
        }}
      >
        {labels[props.snapshot.status]}
      </span>
      {props.snapshot.status === "failed" && (
        <button
          type="button"
          class="rounded px-1.5 py-1 text-text-strong hover:bg-surface-raised-base focus-visible:outline focus-visible:outline-2"
          onClick={props.onRetry}
        >
          Retry
        </button>
      )}
    </div>
  )
}
