import { createSignal, onCleanup, onMount, Show, type ParentProps } from "solid-js"

const PLACEHOLDER_DELAY_MS = 150

export function Placeholder(props: ParentProps<{ readonly label: string }>) {
  const [shown, setShown] = createSignal(false)
  onMount(() => {
    const timer = window.setTimeout(() => setShown(true), PLACEHOLDER_DELAY_MS)
    onCleanup(() => window.clearTimeout(timer))
  })
  return (
    <Show when={shown()}>
      <div role="status" aria-label={props.label} class="flex flex-col gap-1 p-2">
        {props.children}
      </div>
    </Show>
  )
}

export function PlaceholderRows(props: { readonly label: string; readonly rows?: number }) {
  const widths = ["82%", "69%", "54%", "61%", "46%"]
  return (
    <Placeholder label={props.label}>
      {widths.slice(0, props.rows ?? 3).map((width) => (
        <div class="h-6 rounded-md bg-surface-base" style={{ width }} />
      ))}
    </Placeholder>
  )
}

export function FailedNotice(props: { readonly message: string; readonly retryLabel: string; readonly onRetry: () => void }) {
  return (
    <div role="alert" class="flex flex-col items-start gap-2 px-3 py-2 text-12-regular text-icon-critical-base">
      <span class="break-words">{props.message}</span>
      <button
        type="button"
        class="min-h-7 rounded-md border border-border-weak-base px-2 text-12-medium text-text-base pointer-coarse:min-h-11"
        onClick={() => props.onRetry()}
      >
        {props.retryLabel}
      </button>
    </div>
  )
}
