const ROW_CLASS =
  "flex w-full flex-col items-start gap-0.5 rounded-lg border border-border-base px-3 py-2.5 text-left transition-colors hover:border-border-interactive-base focus-visible:border-border-interactive-base focus-visible:outline-none aria-checked:border-border-interactive-base aria-checked:bg-surface-raised-base-active"

export function ChoiceRow(props: { readonly checked: boolean; readonly title: string; readonly detail: string; readonly onChoose: () => void }) {
  return (
    <button type="button" role="radio" aria-checked={props.checked} class={ROW_CLASS} onClick={() => props.onChoose()}>
      <span class="text-14-medium text-text-strong">{props.title}</span>
      <span class="text-12-regular text-text-weak">{props.detail}</span>
    </button>
  )
}
