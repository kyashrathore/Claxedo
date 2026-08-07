import { type Component, Show } from "solid-js"
import type { Catalog, CatalogCategoryId } from "./install-flow"

export const CategoryButton: Component<{
  label: string
  active: boolean
  count?: number
  onClick: () => void
}> = (props) => (
  <button
    type="button"
    class="flex h-7 items-center justify-between rounded px-2 text-left text-sm transition-colors"
    classList={{
      "text-text-strong font-medium": props.active,
      "text-text-weak hover:text-text-base": !props.active,
    }}
    onClick={props.onClick}
  >
    <span>{props.label}</span>
    <Show when={typeof props.count === "number" && props.count > 0}>
      <span class="text-2xs tabular-nums text-text-weaker">{props.count}</span>
    </Show>
  </button>
)

export function sectionTitle(active: CatalogCategoryId | "all" | "installed" | "on-machine", categories: Catalog["categories"]) {
  if (active === "all") return "All Extensions"
  if (active === "installed") return "Installed"
  if (active === "on-machine") return "On this machine"
  return categories.find((c) => c.id === active)?.label ?? "Extensions"
}
