import { Show } from "solid-js"

export function SourceMode(props: {
  markdown: string
  reason: string
  unavailable?: boolean
  onInput: (markdown: string) => void
  onBlur: () => void
  onTryRich: () => void
}) {
  return (
    <section class="flex min-h-0 flex-1 flex-col" aria-labelledby="document-source-label">
      <div class="flex items-start justify-between gap-4 border-b border-border-weak-base px-6 py-3">
        <div>
          <div id="document-source-label" class="text-sm font-medium text-text-strong">
            Source mode
          </div>
          <p class="mt-0.5 text-xs text-text-weak">{props.reason}</p>
        </div>
        <div class="flex shrink-0 flex-col items-end gap-1">
          <button
            type="button"
            class="rounded px-2 py-1 text-xs text-text-strong hover:bg-surface-raised-base focus-visible:outline focus-visible:outline-2"
            onClick={props.onTryRich}
          >
            Try rich mode
          </button>
          <Show when={props.unavailable}>
            {/* The reason to the left already says why; this only proves the click landed. */}
            <p class="text-xs text-text-weak" role="status">
              Checked again — still source mode.
            </p>
          </Show>
        </div>
      </div>
      <textarea
        aria-label="Document Markdown source"
        class="min-h-[24rem] flex-1 resize-none bg-background-base px-6 py-5 font-mono text-sm leading-6 text-text-strong outline-none focus-visible:outline focus-visible:outline-2"
        value={props.markdown}
        onInput={(event) => props.onInput(event.currentTarget.value)}
        onBlur={props.onBlur}
        spellcheck={false}
      />
    </section>
  )
}
