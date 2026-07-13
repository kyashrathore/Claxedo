import { Show } from "solid-js"
import { useLocation } from "@solidjs/router"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"

export function GlobalNavigation(props: {
  newProjectLabel: string
  onNewProject?: () => void
  onOpenPages?: () => void
  onOpenMarketplace?: () => void
  onOpenWorkGraph?: () => void
}) {
  // Derive the active surface from the route so the matching nav item shows a
  // selected state (bg + strong text + brighter icon), mirroring the selected
  // session pill and active project header. "New Project" stays a pure action
  // with no selected state.
  const location = useLocation()
  const path = () => location.pathname
  const isWorkGraph = () => path().startsWith("/workgraph")
  const isMarketplace = () => path().startsWith("/marketplace")
  const isPages = () => path().includes("/page/")

  return (
    <div class="flex flex-col gap-0.5 px-2.5 py-1.5 border-b border-border-weak-base/15" data-testid="global-navigation">
      <NavigationRow icon="plus-small" label={props.newProjectLabel} onClick={props.onNewProject} />
      <Show when={props.onOpenPages}><NavigationRow icon="page" label="Pages" onClick={props.onOpenPages} active={isPages()} testId="sidebar-pages-entry" ariaLabel="Open Pages" /></Show>
      <Show when={props.onOpenMarketplace}><NavigationRow icon="marketplace" label="Marketplace" onClick={props.onOpenMarketplace} active={isMarketplace()} testId="sidebar-marketplace-entry" ariaLabel="Open Marketplace" /></Show>
      <Show when={props.onOpenWorkGraph}><NavigationRow icon="workgraph" label="WorkGraph" onClick={props.onOpenWorkGraph} active={isWorkGraph()} testId="sidebar-workgraph-entry" ariaLabel="Open WorkGraph" /></Show>
    </div>
  )
}

function NavigationRow(props: { icon: "plus-small" | "page" | "dot-grid" | "marketplace" | "workgraph"; label: string; onClick?: () => void; active?: boolean; testId?: string; ariaLabel?: string }) {
  return (
    <button
      type="button"
      data-testid={props.testId}
      aria-current={props.active ? "page" : undefined}
      class="w-full flex items-center gap-2 h-7 px-2.5 rounded-md text-[13px] leading-4 font-medium transition-[background-color,color] duration-100 active:scale-[0.98]"
      classList={{
        "bg-surface-base-hover text-text-strong": props.active,
        "text-text-base/80 hover:text-text-base hover:bg-surface-base-hover/35": !props.active,
      }}
      onClick={() => props.onClick?.()}
      aria-label={props.ariaLabel ?? props.label}
    >
      <span class="flex size-4 shrink-0 items-center justify-center">
        <Icon
          name={props.icon}
          size="small"
          class="transition-colors duration-100"
          classList={{
            "text-text-strong": props.active,
            "text-icon-weak-base": !props.active,
          }}
        />
      </span>
      <span class="min-w-0 truncate leading-4">{props.label}</span>
    </button>
  )
}
