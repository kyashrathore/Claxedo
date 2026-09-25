import { createResizeObserver } from "@solid-primitives/resize-observer"
import { onMount, splitProps, type ComponentProps, type JSX } from "solid-js"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { isScrollKeyTarget, scrollKey, scrollKeyOwner } from "@opencode-ai/ui/scroll-view"
import { ScrollThumbElement } from "./scroll-thumb"
import { createScrollThumb } from "./scroll-view-thumb"

export type ScrollViewProps = ComponentProps<"div"> & { readonly viewportRef?: (element: HTMLDivElement) => void }

type ViewportEvent<E extends Event> = E & { currentTarget: HTMLDivElement; target: Element }

const lineAmount = 40
const editableTags = ["INPUT", "TEXTAREA", "SELECT"]

function forwardEvent<E extends Event>(handler: JSX.EventHandlerUnion<HTMLDivElement, E> | undefined, event: ViewportEvent<E>) {
  if (typeof handler === "function") handler(event)
  else if (handler) handler[0](handler[1], event)
}

function scrollByKey(viewport: HTMLDivElement, event: KeyboardEvent): boolean {
  const active = document.activeElement
  if (active && editableTags.includes(active.tagName)) return false
  const key = scrollKey(event)
  if (!key || !isScrollKeyTarget(event.target, key) || scrollKeyOwner(viewport, event.target, key) !== viewport) return false
  event.preventDefault()
  const page = viewport.clientHeight * 0.8
  if (key === "page-down") viewport.scrollBy({ top: page, behavior: "smooth" })
  if (key === "page-up") viewport.scrollBy({ top: -page, behavior: "smooth" })
  if (key === "home") viewport.scrollTo({ top: 0, behavior: "instant" })
  if (key === "end") viewport.scrollTo({ top: viewport.scrollHeight, behavior: "instant" })
  if (key === "up") viewport.scrollBy({ top: -lineAmount, behavior: "smooth" })
  if (key === "down") viewport.scrollBy({ top: lineAmount, behavior: "smooth" })
  return true
}

export function ScrollView(props: ScrollViewProps): JSX.Element {
  const i18n = useI18n()
  const [local, events, rest] = splitProps(
    props,
    ["class", "children", "viewportRef", "style"],
    ["onScroll", "onWheel", "onTouchStart", "onTouchMove", "onTouchEnd", "onTouchCancel", "onPointerDown", "onClick", "onKeyDown"],
  )
  let viewport!: HTMLDivElement
  const thumb = createScrollThumb({ viewport: () => viewport, track: () => undefined, visibility: () => "hover" })
  onMount(() => {
    local.viewportRef?.(viewport)
    createResizeObserver(
      () => [viewport, viewport.firstElementChild].filter((element): element is HTMLElement => element instanceof HTMLElement),
      thumb.resized,
    )
  })
  return (
    <div
      class={`scroll-view ${local.class || ""}`}
      style={local.style}
      onPointerEnter={() => thumb.setHovered(true)}
      onPointerLeave={() => thumb.setHovered(false)}
      {...rest}
    >
      <div
        ref={viewport}
        class="scroll-view__viewport"
        data-scrollable
        tabIndex={0}
        role="region"
        aria-label={i18n.t("ui.scrollView.ariaLabel")}
        onScroll={(event) => {
          thumb.scrolled()
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
          if (scrollByKey(viewport, event)) thumb.reveal("keyboard")
          forwardEvent(events.onKeyDown, event)
        }}
      >
        {local.children}
      </div>
      <ScrollThumbElement thumb={thumb} class="scroll-view__thumb" />
    </div>
  )
}
