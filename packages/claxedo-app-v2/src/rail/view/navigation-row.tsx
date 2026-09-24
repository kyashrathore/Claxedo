import { Match, Show, Switch, type JSX } from "solid-js"
import type { HoverEngagement } from "../hover-engagement"
import type { NavigationStatus } from "../model"

const ROW_SHELL_CLASS =
  "relative flex items-center gap-2 min-h-7 py-0.5 pr-2.5 mx-1 text-left outline-none rounded-md hover:bg-surface-base-hover/40"

export type NavigationRowProps = {
  readonly data?: Readonly<Record<string, string | undefined>>
  readonly classList?: Readonly<Record<string, boolean | undefined>>
  readonly label: string
  readonly active: boolean
  readonly onActivate: () => void
  readonly onContextMenu?: (event: MouseEvent) => void
  readonly engagement: HoverEngagement
  readonly children: JSX.Element
}

export function NavigationRow(props: NavigationRowProps): JSX.Element {
  return (
    <div
      {...props.data}
      data-active={props.active ? "true" : "false"}
      class={ROW_SHELL_CLASS}
      classList={props.classList}
      onPointerEnter={props.engagement.handlers.onPointerEnter}
      onPointerLeave={props.engagement.handlers.onPointerLeave}
      onFocusIn={props.engagement.handlers.onFocusIn}
      onFocusOut={props.engagement.handlers.onFocusOut}
      onDblClick={props.onContextMenu}
      onContextMenu={props.onContextMenu}
    >
      <button
        type="button"
        data-slot="navigation-row-activate"
        aria-label={props.label}
        aria-current={props.active ? "page" : undefined}
        class="ui-navigation-row-activate absolute inset-0 rounded-md outline-none touch-pan-y focus-visible:ring-2 focus-visible:ring-border-interactive-base"
        onClick={() => props.onActivate()}
      />
      {props.children}
    </div>
  )
}

export function NavigationRowGlyph(props: { readonly children: JSX.Element }): JSX.Element {
  return (
    <span
      data-slot="navigation-row-glyph"
      class="absolute left-4 top-1/2 -translate-y-1/2 z-[1] pointer-events-none flex size-4 items-center justify-center"
    >
      {props.children}
    </span>
  )
}

export function NavigationRowStatusGutter(props: { readonly status: NavigationStatus }): JSX.Element {
  return (
    <Show when={props.status !== "idle"}>
      <NavigationRowGlyph>
        <NavigationStatusMark status={props.status} />
      </NavigationRowGlyph>
    </Show>
  )
}

export function NavigationStatusMark(props: { readonly status: NavigationStatus }): JSX.Element {
  return (
    <Switch>
      <Match when={props.status === "working"}>
        <span aria-hidden="true" data-sidebar-status={props.status} class="flex size-4 shrink-0 translate-y-[0.5px] items-center justify-center">
          <span class="size-[10px] rounded-full border-[1.5px] border-icon-weak-base border-t-transparent animate-spin motion-reduce:animate-none" />
        </span>
      </Match>
      <Match when={props.status !== "idle"}>
        <span aria-hidden="true" data-sidebar-status={props.status} class="size-1.5 shrink-0 rounded-full bg-icon-interactive-base" />
      </Match>
    </Switch>
  )
}
