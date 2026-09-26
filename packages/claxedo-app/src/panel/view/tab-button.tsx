import type { JSX } from "solid-js"
import { AgentGlyph } from "@/transcript"
import { ClaxedoIcon as Icon, ClaxedoIconButton as IconButton, type ClaxedoIconName } from "@/ui"
import type { ReviewWorkspaceTab } from "../workspace-tabs"

export type ReviewWorkspaceTabButtonProps = {
  tab: ReviewWorkspaceTab
  selected: boolean
  label: string
  icon: ClaxedoIconName
  iconPx: number
  closeLabel: string
  onActivate: () => void
  onClose: () => void
  closable: boolean
}

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
        {props.tab.kind === "subagent" ? (
          <span class="flex size-4 shrink-0 items-center justify-center">
            <AgentGlyph seed={props.tab.sessionId} size={props.iconPx} />
          </span>
        ) : (
          <Icon
            name={props.icon}
            size="small"
            style={{ width: `${props.iconPx}px`, height: `${props.iconPx}px`, margin: `${(16 - props.iconPx) / 2}px` }}
            classList={{ "text-icon-base": props.selected, "text-icon-weak-base": !props.selected }}
          />
        )}
        <span class="truncate">{props.label}</span>
      </button>
      <div class="absolute right-1 flex h-full items-center">
        <div class="flex" data-testid="workspace-tab-close" data-workspace-tab-id={props.tab.id}>
          <TabCloseButton label={props.closeLabel} visible={props.selected} onClose={props.onClose} />
        </div>
      </div>
    </div>
  )
}
