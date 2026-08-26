import {
  createEffect,
  createMemo,
  mergeProps,
  onCleanup,
  onMount,
  Show,
  splitProps,
  type Accessor,
  type ComponentProps,
} from "solid-js"
import { Portal } from "solid-js/web"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { createStore } from "solid-js/store"
import { useI18n } from "../context/i18n"

export type ScrollViewThumbVisibility = "hover" | "scroll"

export type ScrollViewThumbRevealSource = "viewport-scroll" | "wheel" | "touch" | "pen" | "keyboard"
type ScrollViewThumbUserInput = Exclude<ScrollViewThumbRevealSource, "viewport-scroll">

/**
 * A viewport `scroll` event is a geometry notification, not proof of user
 * intent. Assigning `scrollTop` and virtualizer bottom anchoring dispatch the
 * same event as a wheel gesture; revealing the thumb from that event made
 * hidden retained surfaces run 200 ms opacity transitions whenever another
 * session activated. User input is observed at its authoritative boundary
 * instead.
 */
export function scrollViewThumbShouldReveal(source: ScrollViewThumbRevealSource) {
  return source !== "viewport-scroll"
}

export interface ScrollViewProps extends ComponentProps<"div"> {
  viewportRef?: (el: HTMLDivElement) => void
  orientation?: "vertical" | "horizontal" // currently only vertical is fully implemented for thumb
  /**
   * `hover`: show while hovered or scrolling. `scroll`: show only while scrolling.
   *
   * In most cases, scrolling a container = hovering over it, so this change has no effect.
   * This is a special case to account for the home page scroll, where scrolling a container != hovering over it
   * */
  thumbVisibility?: ScrollViewThumbVisibility
  /** Mount the thumb into an external track. Scroll metrics still come from this ScrollView. */
  thumbContainer?: HTMLElement | Accessor<HTMLElement | undefined>
  /** Element whose hover reveals the thumb. Defaults to the ScrollView root when unset. */
  thumbHoverTarget?: HTMLElement | Accessor<HTMLElement | undefined>
}

export const scrollKey = (event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">) => {
  if (event.altKey || event.ctrlKey || event.metaKey) return
  if (event.shiftKey && event.key !== " ") return

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
  }
}

export function canScrollKey(element: HTMLElement, key: NonNullable<ReturnType<typeof scrollKey>>) {
  const up = key === "up" || key === "page-up" || key === "home"
  return up ? element.scrollTop > 0 : element.scrollTop + element.clientHeight < element.scrollHeight
}

export function scrollKeyOwner(
  root: HTMLElement,
  target: EventTarget | null,
  key: NonNullable<ReturnType<typeof scrollKey>>,
) {
  const element = target instanceof Element ? target : undefined
  const owner = element?.closest<HTMLElement>("[data-scrollable]")
  if (!owner || owner === root) return root
  if (!root.contains(owner)) return owner
  return canScrollKey(owner, key) ? owner : root
}

export function isScrollKeyTarget(target: EventTarget | null, key: NonNullable<ReturnType<typeof scrollKey>>) {
  const element = target instanceof HTMLElement ? target : undefined
  if (!element) return true
  if (["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) || element.isContentEditable) return false
  if ((key === "page-up" || key === "page-down") && element.closest('button, a[href], [role="button"]')) return false
  return true
}

export function scrollTopFromThumbPointer(input: {
  pointer: number
  viewportTop: number
  grabOffset: number
  clientHeight: number
  scrollHeight: number
  thumbHeight: number
  /** Viewport height used for max scroll. Defaults to `clientHeight` (track == viewport). */
  scrollClientHeight?: number
}) {
  const padding = 8
  const maxThumbTop = input.clientHeight - padding * 2 - input.thumbHeight
  if (maxThumbTop <= 0) return 0
  const thumbTop = Math.max(0, Math.min(input.pointer - input.viewportTop - padding - input.grabOffset, maxThumbTop))
  return (thumbTop / maxThumbTop) * Math.max(0, input.scrollHeight - (input.scrollClientHeight ?? input.clientHeight))
}

export function ScrollView(props: ScrollViewProps) {
  const i18n = useI18n()
  const merged = mergeProps({ orientation: "vertical", thumbVisibility: "hover" }, props)
  const [local, events, rest] = splitProps(
    merged,
    [
      "class",
      "children",
      "viewportRef",
      "orientation",
      "thumbVisibility",
      "thumbContainer",
      "thumbHoverTarget",
      "style",
    ],
    [
      "onScroll",
      "onWheel",
      "onTouchStart",
      "onTouchMove",
      "onTouchEnd",
      "onTouchCancel",
      "onPointerDown",
      "onClick",
      "onKeyDown",
    ],
  )

  let rootRef!: HTMLDivElement
  let viewportRef!: HTMLDivElement
  let thumbRef!: HTMLDivElement

  const resolveEl = (value: HTMLElement | Accessor<HTMLElement | undefined> | undefined) => {
    if (typeof value === "function") return value()
    return value
  }

  const thumbMount = createMemo(() => resolveEl(local.thumbContainer))
  const thumbHover = createMemo(() => resolveEl(local.thumbHoverTarget))
  const hoverRoot = () => !local.thumbHoverTarget && !local.thumbContainer

  const [state, setState] = createStore({
    isHovered: false,
    isDragging: false,
    isScrolling: false,
    thumbHeight: 0,
    thumbTop: 0,
    showThumb: false,
  })
  const isHovered = () => state.isHovered
  const isDragging = () => state.isDragging
  const isScrolling = () => state.isScrolling
  const thumbHeight = () => state.thumbHeight
  const thumbTop = () => state.thumbTop
  const showThumb = () => state.showThumb

  let scrollIdleTimer: ReturnType<typeof setTimeout> | undefined

  const markScrolling = (source: ScrollViewThumbUserInput) => {
    if (!scrollViewThumbShouldReveal(source)) return
    setState("isScrolling", true)
    if (scrollIdleTimer !== undefined) clearTimeout(scrollIdleTimer)
    scrollIdleTimer = setTimeout(() => setState("isScrolling", false), 800)
  }

  const thumbVisible = () => {
    if (isDragging()) return true
    if (isScrolling()) return true
    return local.thumbVisibility === "hover" && isHovered()
  }

  onCleanup(() => {
    if (scrollIdleTimer !== undefined) clearTimeout(scrollIdleTimer)
  })

  // Coalesce thumb geometry to one computation per frame. The raw handler ran
  // on EVERY scroll event and EVERY content resize — during a session switch
  // the virtualized timeline resizes its content dozens of times a frame while
  // scrolling programmatically, and each call forces synchronous layout reads
  // (scrollHeight/clientHeight) interleaved with the virtualizer's writes.
  let thumbFrame: number | undefined
  const scheduleThumbUpdate = () => {
    if (thumbFrame !== undefined) return
    thumbFrame = requestAnimationFrame(() => {
      thumbFrame = undefined
      updateThumb()
    })
  }
  onCleanup(() => {
    if (thumbFrame !== undefined) cancelAnimationFrame(thumbFrame)
  })

  const updateThumb = () => {
    if (!viewportRef) return
    const { scrollTop, scrollHeight, clientHeight } = viewportRef

    if (scrollHeight <= clientHeight || scrollHeight === 0) {
      setState("showThumb", false)
      return
    }

    setState("showThumb", true)
    const trackPadding = 8
    const trackClientHeight = thumbMount()?.clientHeight || clientHeight
    const trackHeight = trackClientHeight - trackPadding * 2

    const minThumbHeight = 32
    // Calculate raw thumb height based on ratio
    let height = (clientHeight / scrollHeight) * trackHeight
    height = Math.max(height, minThumbHeight)

    const maxScrollTop = scrollHeight - clientHeight
    const maxThumbTop = trackHeight - height

    const top = maxScrollTop > 0 ? (scrollTop / maxScrollTop) * maxThumbTop : 0

    // Ensure thumb stays within bounds (shouldn't be necessary due to math above, but good for safety)
    const boundedTop = trackPadding + Math.max(0, Math.min(top, maxThumbTop))

    setState("thumbHeight", height)
    setState("thumbTop", boundedTop)
  }

  onMount(() => {
    if (local.viewportRef) {
      local.viewportRef(viewportRef)
    }

    createResizeObserver(
      () => [viewportRef, viewportRef.firstElementChild, thumbMount()].filter(Boolean) as HTMLElement[],
      scheduleThumbUpdate,
    )

    updateThumb()
  })

  createEffect(() => {
    thumbMount()
    updateThumb()
  })

  createEffect(() => {
    const target = thumbHover()
    if (!target) return

    const enter = () => setState("isHovered", true)
    const leave = () => setState("isHovered", false)
    target.addEventListener("pointerenter", enter)
    target.addEventListener("pointerleave", leave)
    onCleanup(() => {
      target.removeEventListener("pointerenter", enter)
      target.removeEventListener("pointerleave", leave)
      setState("isHovered", false)
    })
  })

  const onThumbPointerDown = (e: PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setState("isDragging", true)
    const grabOffset = e.clientY - thumbRef.getBoundingClientRect().top
    const track = thumbMount() ?? viewportRef

    thumbRef.setPointerCapture(e.pointerId)

    const onPointerMove = (e: PointerEvent) => {
      const { scrollHeight, clientHeight } = viewportRef
      viewportRef.scrollTop = scrollTopFromThumbPointer({
        pointer: e.clientY,
        viewportTop: track.getBoundingClientRect().top,
        grabOffset,
        clientHeight: track.clientHeight,
        scrollClientHeight: clientHeight,
        scrollHeight,
        thumbHeight: thumbHeight(),
      })
    }

    const done = (e: PointerEvent) => {
      setState("isDragging", false)
      thumbRef.releasePointerCapture(e.pointerId)
      thumbRef.removeEventListener("pointermove", onPointerMove)
      thumbRef.removeEventListener("pointerup", done)
      thumbRef.removeEventListener("pointercancel", done)
    }

    thumbRef.addEventListener("pointermove", onPointerMove)
    thumbRef.addEventListener("pointerup", done)
    thumbRef.addEventListener("pointercancel", done)
  }

  const renderThumb = () => (
    <div
      ref={(el) => {
        thumbRef = el
      }}
      onPointerDown={onThumbPointerDown}
      class="scroll-view__thumb"
      data-visible={thumbVisible()}
      data-dragging={isDragging()}
      style={{
        height: `${thumbHeight()}px`,
        transform: `translateY(${thumbTop()}px)`,
        "z-index": 100, // ensure it displays over content
      }}
    />
  )

  // Keybinds implementation
  // We ensure the viewport has a tabindex so it can receive focus
  // We can also explicitly catch PageUp/Down if we want smooth scroll or specific behavior,
  // but native usually handles this perfectly. Let's explicitly ensure it behaves well.
  const onKeyDown = (e: KeyboardEvent) => {
    // If user is focused on an input inside the scroll view, don't hijack keys
    if (document.activeElement && ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) {
      return
    }
    const next = scrollKey(e)
    if (!next) return
    if (!isScrollKeyTarget(e.target, next)) return
    if (scrollKeyOwner(viewportRef, e.target, next) !== viewportRef) return
    markScrolling("keyboard")

    const scrollAmount = viewportRef.clientHeight * 0.8
    const lineAmount = 40

    switch (next) {
      case "page-down":
        e.preventDefault()
        viewportRef.scrollBy({ top: scrollAmount, behavior: "smooth" })
        break
      case "page-up":
        e.preventDefault()
        viewportRef.scrollBy({ top: -scrollAmount, behavior: "smooth" })
        break
      case "home":
        e.preventDefault()
        viewportRef.scrollTo({ top: 0, behavior: "smooth" })
        break
      case "end":
        e.preventDefault()
        viewportRef.scrollTo({ top: viewportRef.scrollHeight, behavior: "smooth" })
        break
      case "up":
        e.preventDefault()
        viewportRef.scrollBy({ top: -lineAmount, behavior: "smooth" })
        break
      case "down":
        e.preventDefault()
        viewportRef.scrollBy({ top: lineAmount, behavior: "smooth" })
        break
    }
  }

  return (
    <div
      ref={rootRef}
      class={`scroll-view ${local.class || ""}`}
      style={local.style}
      onPointerEnter={() => {
        if (hoverRoot()) setState("isHovered", true)
      }}
      onPointerLeave={() => {
        if (hoverRoot()) setState("isHovered", false)
      }}
      {...rest}
    >
      {/* Viewport */}
      <div
        ref={viewportRef}
        class="scroll-view__viewport"
        data-scrollable
        onScroll={(e) => {
          scheduleThumbUpdate()
          // Programmatic anchoring and retained-surface resize corrections
          // arrive here too. Geometry must stay current, but only an input
          // boundary below may reveal the user-scrolling affordance.
          if (typeof events.onScroll === "function") events.onScroll(e as any)
        }}
        onWheel={(e) => {
          markScrolling("wheel")
          const handler = events.onWheel
          if (typeof handler === "function") handler(e as any)
          if (Array.isArray(handler)) handler[0](handler[1], e as any)
        }}
        onTouchStart={(e) => {
          markScrolling("touch")
          const handler = events.onTouchStart
          if (typeof handler === "function") handler(e as any)
          if (Array.isArray(handler)) handler[0](handler[1], e as any)
        }}
        onTouchMove={(e) => {
          // Refresh the idle window for long drags. Touch end then leaves the
          // existing 800 ms window for normal kinetic scrolling.
          markScrolling("touch")
          const handler = events.onTouchMove
          if (typeof handler === "function") handler(e as any)
          if (Array.isArray(handler)) handler[0](handler[1], e as any)
        }}
        onTouchEnd={events.onTouchEnd as any}
        onTouchCancel={events.onTouchCancel as any}
        onPointerDown={(e) => {
          if (e.pointerType === "pen") markScrolling("pen")
          const handler = events.onPointerDown
          if (typeof handler === "function") handler(e as any)
          if (Array.isArray(handler)) handler[0](handler[1], e as any)
        }}
        onClick={events.onClick as any}
        tabIndex={0}
        role="region"
        aria-label={i18n.t("ui.scrollView.ariaLabel")}
        onKeyDown={(e) => {
          onKeyDown(e)
          if (typeof events.onKeyDown === "function") events.onKeyDown(e as any)
        }}
      >
        {local.children}
      </div>

      {/* Thumb Overlay — optionally portaled into an external track */}
      <Show when={showThumb()}>
        <Show when={thumbMount()} fallback={renderThumb()}>
          {(mount) => <Portal mount={mount()}>{renderThumb()}</Portal>}
        </Show>
      </Show>
    </div>
  )
}
