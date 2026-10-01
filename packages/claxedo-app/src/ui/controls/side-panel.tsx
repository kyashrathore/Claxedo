import {
  createEffect,
  createSignal,
  onCleanup,
  Show,
  splitProps,
  type Accessor,
  type JSX,
  type ParentProps,
} from "solid-js"
import {
  createSidePanelExposed,
  SIDE_PANEL_BORDER_WIDTH,
  SIDE_PANEL_INSET_MOTION,
  SIDE_PANEL_MOTION,
} from "@/lib/side-panel-motion"
import { createSidePanelSettle } from "./side-panel-settle"
import { ResizeSeparator, type ResizeSeparatorProps } from "./resize-separator"
import { createSidePanelSlot, SidePanelSlotContext } from "./side-panel-slot"

type SidePanelProps = Omit<JSX.HTMLAttributes<HTMLElement>, "children"> & {
  readonly open: boolean
  readonly width: number
  readonly label: string
  readonly header: JSX.Element
  readonly resize?: Omit<ResizeSeparatorProps, "class" | "grows" | "value" | "onDragging"> & {
    readonly onDragging?: (dragging: boolean) => void
  }
  readonly onAvailable: (width: number) => void
  readonly children: (exposed: Accessor<boolean>) => JSX.Element
}

export function SidePanel(props: SidePanelProps): JSX.Element {
  const [local, attributes] = splitProps(props, [
    "open",
    "width",
    "label",
    "header",
    "resize",
    "onAvailable",
    "children",
  ])
  const [dragging, setDragging] = createSignal(false)
  const exposed = createSidePanelExposed(() => local.open)
  let aside: HTMLElement | undefined
  const settled = createSidePanelSettle(
    () => aside,
    () => local.open,
  )
  createEffect(() => {
    const parent = aside?.parentElement
    if (!exposed() || !parent) return
    const measure = () => local.onAvailable(parent.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(parent)
    onCleanup(() => observer.disconnect())
  })
  return (
    <aside
      {...attributes}
      ref={aside}
      aria-label={exposed() ? local.label : undefined}
      aria-hidden={exposed() ? undefined : "true"}
      role={exposed() ? "complementary" : undefined}
      data-open={local.open ? "true" : "false"}
      data-shell-settled={settled() ? "true" : "false"}
      class="absolute bottom-0 right-0 top-0 z-30 flex flex-col overflow-hidden bg-background-base will-change-[transform,opacity]"
      classList={{ "pointer-events-none": !local.open }}
      style={{
        width: `${local.width}px`,
        "border-left": `${SIDE_PANEL_BORDER_WIDTH}px solid var(--border-weaker-base)`,
        contain: "strict",
        "backface-visibility": "hidden",
        transform: local.open ? "translate3d(0, 0, 0)" : "translate3d(100%, 0, 0)",
        transition: dragging() ? "none" : SIDE_PANEL_MOTION,
        display: exposed() ? undefined : "none",
        visibility: exposed() ? "visible" : "hidden",
      }}
    >
      <Show when={local.resize}>
        {(resize) => {
          const notifyDragging = resize().onDragging
          return (
            <ResizeSeparator
              {...resize()}
              value={local.width}
              grows="left"
              class="left-0 w-1 hover:bg-border-weak-base/25 focus-visible:bg-border-interactive-base/60 active:bg-border-weak-base/45"
              onDragging={(value) => {
                setDragging(value)
                notifyDragging?.(value)
              }}
            />
          )
        }}
      </Show>
      <div class="shrink-0">{local.header}</div>
      <div class="relative min-h-0 flex-1">{local.children(exposed)}</div>
    </aside>
  )
}

type ContentAttributes = JSX.HTMLAttributes<HTMLDivElement> & { readonly [key: `data-${string}`]: string | undefined }

export function SidePanelArea(
  props: ParentProps<{
    readonly inset: number
    readonly panel: JSX.Element
    readonly contentAttributes?: ContentAttributes
  }>,
): JSX.Element {
  const host = createSidePanelSlot()
  return (
    <SidePanelSlotContext.Provider value={host.register}>
      <div class="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div
          {...props.contentAttributes}
          class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden will-change-[margin-right]"
          style={{ "margin-right": `${host.slot()?.inset ?? props.inset}px`, transition: SIDE_PANEL_INSET_MOTION }}
        >
          {props.children}
        </div>
        <Show when={host.slot()} fallback={props.panel}>
          {(slot) => slot().panel}
        </Show>
      </div>
    </SidePanelSlotContext.Provider>
  )
}
