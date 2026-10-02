import { Match, onCleanup, Show, Switch, type JSX } from "solid-js"
import { useDragSource, useWorkbench } from "@/workbench"
import type { HoverEngagement } from "../hover-engagement"
import type { NavigationStatus } from "../model"

const ROW_SHELL_CLASS =
  "sidebar-row relative flex items-center gap-2 py-0.5 mx-1 text-left outline-none hover:bg-surface-base-hover/40"

export type NavigationRowProps = {
  readonly class?: string
  readonly data?: Readonly<Record<string, string | undefined>>
  readonly classList?: Readonly<Record<string, boolean | undefined>>
  readonly label: string
  readonly active: boolean
  readonly onActivate: () => void
  readonly onContextMenu?: (event: MouseEvent) => void
  readonly engagement: HoverEngagement
  readonly prepareDrag?: () => string | undefined
  readonly children: JSX.Element
}

export function NavigationRow(props: NavigationRowProps): JSX.Element {
  const workbench = useWorkbench()
  const drag = (element: HTMLElement) => {
    const prepare = props.prepareDrag
    if (!prepare) return
    const dispose = useDragSource(workbench.drag, element, {
      contentId: prepare,
      sourceKind: "navigation-row",
      label: () => props.label,
      onDropMissed: () => props.onActivate(),
    })
    onCleanup(dispose)
  }
  return (
    <div
      ref={drag}
      {...props.data}
      data-active={props.active ? "true" : "false"}
      class={props.class ? `${ROW_SHELL_CLASS} ${props.class}` : ROW_SHELL_CLASS}
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
        aria-label={props.label}
        aria-current={props.active ? "page" : undefined}
        data-slot="navigation-row-activate"
        class="ui-navigation-row-activate absolute inset-0 rounded-[inherit] outline-none touch-pan-y focus-visible:ring-2 focus-visible:ring-border-interactive-base"
        onClick={() => props.onActivate()}
      />
      {props.children}
    </div>
  )
}

export function NavigationRowGlyph(props: { readonly children: JSX.Element }): JSX.Element {
  return (
    <span
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

export function NavigationStatusMark(props: { readonly status: NavigationStatus; readonly surface?: "sidebar" | "switcher" }): JSX.Element {
  const data = () => (props.surface === "switcher" ? { "data-switcher-status": props.status } : { "data-sidebar-status": props.status })
  return (
    <Switch>
      <Match when={props.status === "working"}>
        <span aria-hidden="true" {...data()} class="flex size-4 shrink-0 translate-y-[0.5px] items-center justify-center">
          <span
            class="rounded-full border-[1.5px] border-icon-weak-base border-t-transparent animate-spin motion-reduce:animate-none"
            classList={{ "size-[8.5px]": props.surface === "switcher", "size-[10px]": props.surface !== "switcher" }}
          />
        </span>
      </Match>
      <Match when={props.status === "background"}>
        <span aria-hidden="true" {...data()} class="flex size-4 shrink-0 translate-y-[0.5px] items-center justify-center">
          <span
            class="flex items-center justify-center rounded-full border-[1.5px] border-icon-weak-base animate-pulse motion-reduce:animate-none"
            classList={{ "size-[8.5px]": props.surface === "switcher", "size-[10px]": props.surface !== "switcher" }}
          >
            <span class="size-[3px] rounded-full bg-icon-weak-base" />
          </span>
        </span>
      </Match>
      <Match when={props.status !== "idle"}>
        <span
          aria-hidden="true"
          {...data()}
          class="size-1.5 shrink-0 rounded-full"
          classList={{
            "bg-icon-interactive-base": props.status === "permission" || props.status === "error",
            "bg-text-weak": props.status === "done",
          }}
        />
      </Match>
    </Switch>
  )
}
