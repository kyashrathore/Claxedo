import { For } from "solid-js"

export type UsageView = "quota" | "claxedo" | "total"

export function UsageScopeSwitcher(props: { selected: UsageView; onSelect: (view: UsageView) => void }) {
  const options = [
    { id: "quota" as const, label: "Usage limits" },
    { id: "claxedo" as const, label: "Usage through Claxedo" },
    { id: "total" as const, label: "Total local usage" },
  ]

  return (
    <div class="workspace-page-segmented usage-view-tabs usage-segmented" role="group" aria-label="Usage views">
      <For each={options}>
        {(option) => (
          <button
            type="button"
            class="usage-view-tab"
            aria-pressed={
              (props.selected === option.id) == null ? undefined : props.selected === option.id ? "true" : "false"
            }
            onClick={() => props.onSelect(option.id)}
          >
            {option.label}
          </button>
        )}
      </For>
    </div>
  )
}
