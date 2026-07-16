import { For, Show } from "solid-js"

export function StarterPromptChips(props: {
  prompts?: readonly string[]
  onSelect: (prompt: string) => void
}) {
  return (
    <Show when={props.prompts?.length}>
      <div class="flex flex-wrap gap-2 pb-2" data-testid="starter-prompt-chips" aria-label="Starter prompts">
        <For each={props.prompts}>
          {(item) => (
            <button
              type="button"
              class="max-w-full truncate rounded-full border border-border-weak-base bg-background-base px-3 py-1.5 text-12-medium text-text-base transition-colors hover:border-border-base hover:bg-background-stronger hover:text-text-strong"
              data-testid="starter-prompt-chip"
              onClick={() => props.onSelect(item)}
            >
              {item}
            </button>
          )}
        </For>
      </div>
    </Show>
  )
}
