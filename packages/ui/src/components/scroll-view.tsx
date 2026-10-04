import { createResizeObserver } from "@solid-primitives/resize-observer"
import { onMount, splitProps, type ComponentProps, type JSX } from "solid-js"
import { useI18n } from "../context/i18n"
import { ScrollThumbElement } from "./scroll-thumb"
import { createScrollThumb } from "./scroll-view-thumb"

export { scrollTopFromThumbPointer, type ScrollViewThumbVisibility } from "./scroll-view-thumb"

export type ScrollKeyAction = "page-down" | "page-up" | "home" | "end" | "up" | "down"

export const scrollKey = (
  event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">,
): ScrollKeyAction | undefined => {
  if (event.altKey || event.ctrlKey || event.metaKey) return undefined
  if (event.shiftKey && event.key !== " ") return undefined

  switch (event.key) {
    case "PageDown":
      return "page-down"
    case "PageUp":
      return "page-up"
    case "Home":
      return "home"
    case "End":
      return "end"
    case "ArrowUp":
      return "up"
    case "ArrowDown":
      return "down"
    case " ":
      return event.shiftKey ? "page-up" : "page-down"
    default:
      return undefined
  }
}

export function canScrollKey(element: HTMLElement, key: ScrollKeyAction) {
  const up = key === "up" || key === "page-up" || key === "home"
  return up ? element.scrollTop > 0 : element.scrollTop + element.clientHeight < element.scrollHeight
}

export function scrollKeyOwner(
  root: HTMLElement,
  target: EventTarget | null,
  key: ScrollKeyAction,
) {
  const element = target instanceof Element ? target : undefined
  const owner = element?.closest<HTMLElement>("[data-scrollable]")
  if (!owner || owner === root) return root
  if (!root.contains(owner)) return owner
  return canScrollKey(owner, key) ? owner : root
}

export function isScrollKeyTarget(target: EventTarget | null, key: ScrollKeyAction) {
  const element = target instanceof HTMLElement ? target : undefined
  if (!element) return true
  if (["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) || element.isContentEditable) return false
  if ((key === "page-up" || key === "page-down") && element.closest('button, a[href], [role="button"]')) return false
  return true
}

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
