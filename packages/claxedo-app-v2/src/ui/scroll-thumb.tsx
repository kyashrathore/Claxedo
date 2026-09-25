import { createResizeObserver } from "@solid-primitives/resize-observer"
import { createEffect, onCleanup, type JSX } from "solid-js"
import { createScrollThumb, type ScrollViewThumbVisibility } from "./scroll-view-thumb"
import "./scroll-thumb.css"

type ScrollThumbState = ReturnType<typeof createScrollThumb>

export function ScrollThumbElement(props: { readonly thumb: ScrollThumbState; readonly class: string }): JSX.Element {
  return (
    <div
      class={props.class}
      hidden={!props.thumb.state.shown}
      data-visible={props.thumb.visible()}
      data-dragging={props.thumb.state.dragging}
      style={{ height: `${props.thumb.state.height}px`, transform: `translateY(${props.thumb.state.top}px)`, "z-index": 100 }}
      onPointerDown={(event) => props.thumb.drag(event.currentTarget, event)}
    />
  )
}

export type ScrollThumbProps = {
  readonly scroller: HTMLDivElement | undefined
  readonly hoverTarget: HTMLElement | undefined
  readonly visibility?: ScrollViewThumbVisibility
}

export function ScrollThumb(props: ScrollThumbProps): JSX.Element {
  const thumb = createScrollThumb({ viewport: () => props.scroller, track: () => undefined, visibility: () => props.visibility ?? "hover" })
  createResizeObserver(
    () =>
      [props.scroller, props.scroller?.firstElementChild].filter(
        (element): element is HTMLElement => element instanceof HTMLElement,
      ),
    thumb.resized,
  )
  createEffect(() => {
    const scroller = props.scroller
    if (!scroller) return
    const onScroll = () => thumb.scrolled()
    const onWheel = () => thumb.reveal("wheel")
    const onTouch = () => thumb.reveal("touch")
    scroller.addEventListener("scroll", onScroll, { passive: true })
    scroller.addEventListener("wheel", onWheel, { passive: true })
    scroller.addEventListener("touchmove", onTouch, { passive: true })
    onCleanup(() => {
      scroller.removeEventListener("scroll", onScroll)
      scroller.removeEventListener("wheel", onWheel)
      scroller.removeEventListener("touchmove", onTouch)
    })
  })
  createEffect(() => {
    const target = props.hoverTarget
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
  return <ScrollThumbElement thumb={thumb} class="v2-scroll-view-thumb" />
}
