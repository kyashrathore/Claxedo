import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { Match, Switch } from "solid-js"
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
  const status = () => props.snapshot.status
  return (
    <div class="flex size-7 items-center justify-center" role="status" aria-live="polite" aria-atomic="true">
      <span class="sr-only">{labels[status()]}</span>
      <Switch>
        <Match when={status() === "saving"}>
          <span
            class="size-3.5 animate-spin rounded-full border border-border-base border-t-transparent"
            aria-hidden="true"
          />
        </Match>
        <Match when={status() === "saved"}>
          <Icon name="check-small" size="small" class="text-icon-weak-base" />
        </Match>
        <Match when={status() === "failed"}>
          <button
            type="button"
            aria-label="Retry"
            title={labels.failed}
            class="flex size-7 items-center justify-center rounded text-text-on-critical-base hover:bg-surface-raised-base focus-visible:outline focus-visible:outline-2"
            onClick={props.onRetry}
          >
            <Icon name="circle-alert" size="small" />
          </button>
        </Match>
        <Match when={status() === "conflicted"}>
          <span class="flex size-7 items-center justify-center text-text-on-critical-base" title={labels.conflicted}>
            <Icon name="circle-alert" size="small" />
          </span>
        </Match>
      </Switch>
    </div>
  )
}
