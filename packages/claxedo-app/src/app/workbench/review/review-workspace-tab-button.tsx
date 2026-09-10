import { Show, type JSX } from "solid-js"
import { ClaxedoIcon as Icon, type ClaxedoIconName } from "@/ui/controls/claxedo-icon"
import { ClaxedoIconButton as IconButton } from "@/ui/controls/claxedo-icon-button"
import type { ReviewWorkspaceTab } from "@/features/review/ui/review-workspace-tabs"
import { AgentGlyph } from "@/ui/session-kit"

export type ReviewWorkspaceTabButtonProps = {
  tab: ReviewWorkspaceTab
  selected: boolean
  label: string
  icon: ClaxedoIconName
  /** Optical size for this tab kind's glyph, inside a shared 16px slot. */
  iconPx: number
  closeLabel: string
  onActivate: () => void
  onClose: () => void
  /** Middle-click close. The Review tab is permanent, so it declines. */
  closable: boolean
}

/**
 * The dismiss affordance. No radius override in `class`: `IconButton` already
 * draws `--radius-sm`, the same corner every other icon button in the app uses.
 * This carried `rounded-full`, which made the one dismiss affordance on the tab
 * a circle.
 */
function TabCloseButton(props: { label: string; visible: boolean; onClose: () => void }): JSX.Element {
  return (
    <IconButton
      icon="close-small"
      variant="ghost"
      class="h-5 w-5 transition-opacity focus-visible:pointer-events-auto focus-visible:opacity-100"
      classList={{
        "opacity-100 pointer-events-auto": props.visible,
        "opacity-0 pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100": !props.visible,
      }}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        props.onClose()
      }}
      aria-label={props.label}
    />
  )
}

export function ReviewWorkspaceTabButton(props: ReviewWorkspaceTabButtonProps): JSX.Element {
  return (
    <div
      data-slot="workspace-tab"
      data-selected={props.selected ? "true" : undefined}
      data-workspace-tab-id={props.tab.id}
      data-workspace-tab-kind={props.tab.kind}
      class="group relative my-1 ml-0.5 flex h-7 max-w-[180px] shrink-0 items-center rounded-md border border-transparent text-13-medium transition-[background-color,color] duration-100"
      classList={{
        "bg-surface-base-hover text-text-base": props.selected,
        "text-text-weak hover:bg-surface-base-hover/35 hover:text-text-base": !props.selected,
      }}
    >
      <button
        type="button"
        class="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2.5 pr-7 leading-none"
        aria-current={props.selected ? "true" : undefined}
        onClick={() => props.onActivate()}
        onAuxClick={(event) => {
          if (event.button !== 1 || !props.closable) return
          event.preventDefault()
          props.onClose()
        }}
      >
        <Show
          when={props.tab.kind !== "subagent" || undefined}
          fallback={
            // The mark the transcript already gave this agent, seeded the same
            // way, so the tab and the card that opened it read as one thing.
            <span class="flex size-4 shrink-0 items-center justify-center">
              <AgentGlyph seed={props.tab.kind === "subagent" ? props.tab.sessionId : ""} size={props.iconPx} />
            </span>
          }
        >
          <Icon
            name={props.icon}
            size="small"
            /* The tab glyph is optically sized per tab kind (13/14/15px) inside
               a 16px slot, so the label sits at the same x whatever the tab is;
               the icon is the box, so the slot is the svg plus a margin.
               Padding would express the same geometry but Blink rasterises an
               outermost <svg> with an inset viewport worse than a margin does,
               which leaves the viewport, its origin, and its raster untouched. */
            style={{ width: `${props.iconPx}px`, height: `${props.iconPx}px`, margin: `${(16 - props.iconPx) / 2}px` }}
            classList={{ "text-icon-base": props.selected, "text-icon-weak-base": !props.selected }}
          />
        </Show>
        <span class="truncate">{props.label}</span>
      </button>
      <div class="absolute right-1 flex h-full items-center">
        {/* `flex` is load-bearing, not cosmetic. As a block, this wrapper laid
            out the inline-flex button on a text baseline, so it measured 22px
            around a 20px button — 2px of descender space below. `items-center`
            centred the 22px box, leaving the X one pixel above the label and
            the tab's own glyph. */}
        <div class="flex" data-testid="workspace-tab-close" data-workspace-tab-id={props.tab.id}>
          <TabCloseButton label={props.closeLabel} visible={props.selected} onClose={props.onClose} />
        </div>
      </div>
    </div>
  )
}
