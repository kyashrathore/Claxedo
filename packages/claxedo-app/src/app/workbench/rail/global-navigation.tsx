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
  const isDocuments = () => path().includes("/page/")

  return (
    <div
      data-testid="global-navigation"
      data-slot="global-navigation"
      class="flex flex-col gap-0.5 px-2.5 py-1.5 border-b border-border-weak-base/15"
    >
      <NavigationRow icon="plus-small" label={props.newProjectLabel} onClick={props.onNewProject} />
      <Show when={props.onOpenPages}>
        <NavigationRow
          icon="page"
          label="Documents"
          onClick={props.onOpenPages}
          active={isDocuments()}
          testId="sidebar-documents-entry"
          ariaLabel="Open Documents"
        />
      </Show>
      <Show when={props.onOpenMarketplace}>
        <NavigationRow
          icon="marketplace"
          label="Marketplace"
          onClick={props.onOpenMarketplace}
          active={isMarketplace()}
          testId="sidebar-marketplace-entry"
          ariaLabel="Open Marketplace"
        />
      </Show>
      <Show when={props.onOpenWorkGraph}>
        <NavigationRow
          icon="workgraph"
          label="WorkGraph"
          onClick={props.onOpenWorkGraph}
          active={isWorkGraph()}
          testId="sidebar-workgraph-entry"
          ariaLabel="Open WorkGraph"
        />
      </Show>
    </div>
  )
}

function NavigationRow(props: {
  icon: "plus-small" | "page" | "dot-grid" | "marketplace" | "workgraph"
  label: string
  onClick?: () => void
  active?: boolean
  testId?: string
  ariaLabel?: string
}) {
  return (
    <button
      type="button"
      data-testid={props.testId}
      aria-current={props.active ? "page" : undefined}
      class={[
        "w-full flex items-center gap-2 h-7 px-2.5 rounded-md text-compact leading-4 font-medium transition-[background-color,color] duration-100 active:scale-[0.98]",
        {
          "bg-surface-base-hover text-text-strong": !!props.active,
          "text-text-base/80 hover:text-text-base hover:bg-surface-base-hover/35": !props.active,
        },
      ]}

      onClick={() => props.onClick?.()}
      aria-label={props.ariaLabel ?? props.label}
    >
      {/*
        The interaction attribute IS the color. `data-icon-interaction` paints
        the wrapper and forces the glyph to `inherit` (see the icon-interaction
        grammar in app/styles/ui-overrides.css), so a utility class on the Icon
        cannot win — an unconditional "persistent" here rendered every row's
        glyph at the emphasized color and flattened the active state. Vary the
        attribute instead: persistent when this row is the current page, passive
        otherwise.
      */}
      <span
        data-icon-interaction={props.active ? "persistent" : "passive"}
        class="flex size-4 shrink-0 items-center justify-center"
      >
        <Icon name={props.icon} size="small" class="transition-colors duration-100" />
      </span>
      <span class="min-w-0 truncate leading-4">{props.label}</span>
    </button>
  )
}
