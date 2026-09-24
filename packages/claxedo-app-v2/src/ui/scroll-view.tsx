import { createResizeObserver } from "@solid-primitives/resize-observer"
import { createEffect, createMemo, mergeProps, onCleanup, onMount, Show, splitProps, type Accessor, type ComponentProps, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { isScrollKeyTarget, scrollByKey, scrollKey, scrollKeyOwner } from "./scroll-view-keys"
import { createScrollThumb, type ScrollViewThumbVisibility } from "./scroll-view-thumb"
import "./scroll-view.css"

export interface ScrollViewProps extends ComponentProps<"div"> {
  viewportRef?: (element: HTMLDivElement) => void
  label?: string
  thumbVisibility?: ScrollViewThumbVisibility
  thumbContainer?: HTMLElement | Accessor<HTMLElement | undefined>
  thumbHoverTarget?: HTMLElement | Accessor<HTMLElement | undefined>
}

function forwardEvent<E extends Event>(
  handler: JSX.EventHandlerUnion<HTMLDivElement, E> | undefined,
  event: E & { currentTarget: HTMLDivElement; target: Element },
) {
  if (typeof handler === "function") handler(event)
  else if (handler) handler[0](handler[1], event)
}

const resolveElement = (value: HTMLElement | Accessor<HTMLElement | undefined> | undefined) =>
  typeof value === "function" ? value() : value

export function ScrollView(props: ScrollViewProps) {
  const merged = mergeProps({ thumbVisibility: "hover" as ScrollViewThumbVisibility, label: "Scrollable content" }, props)
  const [local, events, rest] = splitProps(
    merged,
    ["class", "children", "viewportRef", "label", "thumbVisibility", "thumbContainer", "thumbHoverTarget", "style"],
    ["onScroll", "onWheel", "onTouchStart", "onTouchMove", "onTouchEnd", "onTouchCancel", "onPointerDown", "onClick", "onKeyDown"],
  )
  let viewport: HTMLDivElement | undefined
  const track = createMemo(() => resolveElement(local.thumbContainer))
  const hoverTarget = createMemo(() => resolveElement(local.thumbHoverTarget))
  const hoversRoot = () => !local.thumbHoverTarget && !local.thumbContainer
  const thumb = createScrollThumb({ viewport: () => viewport, track })

  onMount(() => {
    if (viewport) local.viewportRef?.(viewport)
    createResizeObserver(
      () => [viewport, viewport?.firstElementChild, track()].filter((element): element is HTMLElement => element instanceof HTMLElement),
      thumb.schedule,
    )
    thumb.measure()
  })

  createEffect(() => {
    track()
    thumb.measure()
  })

  createEffect(() => {
    const target = hoverTarget()
    if (!target) return
    const enter = () => thumb.setHovered(true)
    const leave = () => thumb.setHovered(false)
    target.addEventListener("pointerenter", enter)
    target.addEventListener("pointerleave", leave)
    onCleanup(() => {
      target.removeEventListener("pointerenter", enter)
      target.removeEventListener("pointerleave", leave)
      thumb.setHovered(false)
    })
  })

  const onKeyDown = (event: KeyboardEvent) => {
    if (!viewport) return
    const active = document.activeElement
    if (active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)) return
    const key = scrollKey(event)
    if (!key || !isScrollKeyTarget(event.target, key) || scrollKeyOwner(viewport, event.target, key) !== viewport) return
    thumb.reveal("keyboard")
    event.preventDefault()
    scrollByKey(viewport, key)
  }

  const renderThumb = () => (
    <div
      class="scroll-view-thumb"
      data-visible={thumb.visible(local.thumbVisibility)}
      data-dragging={thumb.state.dragging}
      style={{ height: `${thumb.state.height}px`, transform: `translateY(${thumb.state.top}px)` }}
      onPointerDown={(event) => thumb.drag(event.currentTarget, event)}
    />
  )

  return (
    <div
      class={`scroll-view ${local.class || ""}`}
      style={local.style}
      onPointerEnter={() => hoversRoot() && thumb.setHovered(true)}
      onPointerLeave={() => hoversRoot() && thumb.setHovered(false)}
      {...rest}
    >
      <div
        ref={viewport}
        class="scroll-view-viewport"
        data-scrollable
        tabIndex={0}
        role="region"
        aria-label={local.label}
        onScroll={(event) => {
          thumb.schedule()
          forwardEvent(events.onScroll, event)
        }}
        onWheel={(event) => {
          thumb.reveal("wheel")
          forwardEvent(events.onWheel, event)
        }}
        onTouchStart={(event) => {
          thumb.reveal("touch")
          forwardEvent(events.onTouchStart, event)
        }}
        onTouchMove={(event) => {
          thumb.reveal("touch")
          forwardEvent(events.onTouchMove, event)
        }}
        onTouchEnd={events.onTouchEnd}
        onTouchCancel={events.onTouchCancel}
        onPointerDown={(event) => {
          if (event.pointerType === "pen") thumb.reveal("pen")
          forwardEvent(events.onPointerDown, event)
        }}
        onClick={events.onClick}
        onKeyDown={(event) => {
          onKeyDown(event)
          forwardEvent(events.onKeyDown, event)
        }}
      >
        {local.children}
      </div>
      <Show when={thumb.state.shown}>
        <Show when={track()} fallback={renderThumb()}>
          {(mount) => <Portal mount={mount()}>{renderThumb()}</Portal>}
        </Show>
      </Show>
    </div>
  )
}
