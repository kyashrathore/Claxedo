/**
 * ReviewCodeView — stage-1 spike of the Review surface on Pierre's CodeView.
 *
 * One CodeView instance owns the whole changed-file document: layout,
 * virtualization, scrolling, worker-pool highlighting. This component is the
 * Solid boundary around that imperative engine: it maps the review model
 * (files + expansion) onto controlled `CodeViewItem`s and exposes the scroll
 * element to the caller's scroll-restoration machinery.
 *
 * File headers render through Pierre's custom-header mode: the engine leaves a
 * light-DOM slot per file and this component portals the caller's header
 * content into it, wrapped in the accordion header structure the app's review
 * CSS styles. Headers therefore look identical to the accordion list while
 * the engine owns layout and virtualization.
 */
import { CodeView, type CodeViewDiffItem, type CodeViewOptions } from "@pierre/diffs"
import { createEffect, createSignal, For, on, onCleanup, onMount, type JSX } from "solid-js"
import { Portal } from "solid-js/web"

import { getWorkerPool } from "../pierre/worker"
import { resolveFileDiff } from "./session-diff"

export type ReviewCodeViewDiff = {
  file: string
  additions?: number
  deletions?: number
  status?: string
  patch?: string
  before?: string
  after?: string
}

export type ReviewCodeViewProps = {
  diffs: readonly ReviewCodeViewDiff[]
  diffStyle: "unified" | "split"
  /** Expanded file paths; every other file renders collapsed. */
  open: readonly string[]
  onToggleOpen?: (file: string) => void
  /**
   * Header row content for a file (the accordion trigger-content markup).
   * Rendered in light DOM through the engine's header slot, so app CSS and
   * context providers apply. Falls back to Pierre's default header when absent.
   */
  renderHeader?: (file: string) => JSX.Element
  /** Test id for the header trigger button (defaults to a spike-local id). */
  headerTestId?: (file: string) => string | undefined
  /** File whose header row shows the selected highlight. */
  focusedFile?: string
  /** Receives the live scroll element for scroll capture/restoration. */
  scrollRef?: (element: HTMLDivElement) => void
  /**
   * Native scroll events from the scroll element.
   *
   * Typed as Solid's handler rather than a bare `(event: Event) => void` so a
   * caller can forward straight into an `onScroll` prop: Solid's handlers read
   * `currentTarget` as the bound element, and a plain DOM `Event` does not
   * satisfy that, so every consumer was re-asserting the shape at its own call
   * site. Declaring it here moves the one narrowing to `forwardScroll`, which
   * is the only place the element is actually known.
   */
  onScrollEvent?: JSX.EventHandler<HTMLDivElement, Event>
  /** Fired after CodeView commits a render pass with visible content. */
  onDiffRendered?: () => void
  class?: string
}

/**
 * The debug handle the perf harness's CodeView probe reads
 * (`claxedo-app/perf-harness/probes/debug-codeview-probe.ts`). Absent in a normal session.
 */
interface ReviewCodeViewWindow extends Window {
  __reviewCodeView?: CodeView
}

/**
 * The event shape Solid's scroll handlers receive. Derived from `JSX.EventHandler`
 * rather than spelled out, so it cannot drift from what a consumer's `onScroll`
 * expects.
 */
type DivScrollEvent = Parameters<JSX.EventHandler<HTMLDivElement, Event>>[0]

/**
 * Check the handler contract instead of asserting it.
 *
 * `findScroller` returns `HTMLElement`, so div-ness is not known statically --
 * but the listener is attached to that element, so during dispatch
 * `currentTarget` *is* it. Testing both fields makes the narrowing true at
 * runtime rather than promised at compile time, which matters because
 * consumers read `currentTarget` to restore scroll position.
 */
function isDivScrollEvent(event: Event): event is DivScrollEvent {
  return event.currentTarget instanceof HTMLDivElement && event.target instanceof Element
}

export function ReviewCodeView(props: ReviewCodeViewProps) {
  let root: HTMLDivElement | undefined
  let view: CodeView | undefined
  let generation = 0
  let stampFrame: number | undefined

  const openSet = () => new Set(props.open)
  const expanded = (file: string) => openSet().has(file)

  // Per-file light-DOM hosts for the engine's custom-header slots. The engine
  // asks for a host whenever it (re)renders an item's header; the host is
  // created once and a Portal keeps the header content mounted in it across
  // element pooling, so re-renders re-adopt the same live DOM.
  const headerHosts = new Map<string, HTMLDivElement>()
  const [headerFiles, setHeaderFiles] = createSignal<string[]>([])
  const acquireHeaderHost = (file: string) => {
    let host = headerHosts.get(file)
    if (!host) {
      host = document.createElement("div")
      host.dataset.slot = "session-review-header-host"
      headerHosts.set(file, host)
      setHeaderFiles((files) => [...files, file])
    }
    return host
  }

  const buildItems = (): CodeViewDiffItem[] => {
    const open = openSet()
    return props.diffs.map((diff) => ({
      id: diff.file,
      type: "diff" as const,
      fileDiff: resolveFileDiff(diff),
      collapsed: !open.has(diff.file),
      // Encodes both the data generation and the collapse state so controlled
      // reconciliation re-renders exactly the items whose state changed.
      version: generation * 2 + (open.has(diff.file) ? 1 : 0),
    }))
  }

  /**
   * Light-DOM compat markers on CodeView's rendered item containers: the
   * `data-review-file` identity the app's tooling queries. Shadow DOM stays
   * Pierre's.
   */
  const stamp = () => {
    stampFrame = undefined
    const current = view
    const host = root
    if (!current || !host) return
    const rendered = current.getRenderedItems()
    for (const record of rendered) {
      const element = record.element
      if (element.dataset.reviewFile !== record.id) {
        element.dataset.reviewFile = record.id
        element.dataset.slot = "session-review-diff-wrapper"
        // A custom element defaults to display:inline, which computes a zero
        // light-DOM box around shadow content -- invisible to any tooling that
        // measures the host. Give it a real block box.
        element.style.display = "block"
        element.style.minHeight = "1px"
      }
    }
    host.dataset.reviewRenderedFiles = String(rendered.length)
    host.dataset.reviewTotalFiles = String(props.diffs.length)
  }

  const stampSoon = () => {
    if (stampFrame !== undefined) return
    if (typeof requestAnimationFrame !== "function") {
      stamp()
      return
    }
    stampFrame = requestAnimationFrame(stamp)
  }

  const findScroller = (host: HTMLElement): HTMLElement => {
    if (typeof getComputedStyle === "function") {
      const queue: HTMLElement[] = [host]
      while (queue.length) {
        const candidate = queue.shift()!
        const overflow = getComputedStyle(candidate).overflowY
        if (overflow === "auto" || overflow === "scroll" || overflow === "overlay") return candidate
        queue.push(...Array.from(candidate.children).filter((child): child is HTMLElement => child instanceof HTMLElement))
      }
    }
    return host
  }

  onMount(() => {
    const host = root
    if (!host) return
    const options: CodeViewOptions<undefined> = {
      diffStyle: props.diffStyle,
      stickyHeaders: true,
      // Spike diagnostics: let render failures throw instead of being
      // swallowed -- a blank canvas must name its cause.
      disableErrorHandling: true,
      ...(props.renderHeader
        ? { renderCustomHeader: (fileDiff) => acquireHeaderHost(fileDiff.name) }
        : {}),
      onPostRender: () => {
        props.onDiffRendered?.()
        stampSoon()
      },
    }
    // NOT container-managed: the managed mode is the React wrapper's portal
    // path and it disables the vanilla header-slot rendering entirely.
    const instance = new CodeView(options, getWorkerPool(props.diffStyle))
    view = instance
    // Spike diagnostics only: reachable state for the DOM probe
    // (claxedo-app/perf-harness/probes/debug-codeview-probe.ts reads this handle).
    const debugTarget: ReviewCodeViewWindow = window
    debugTarget.__reviewCodeView = instance
    instance.setup(host)
    instance.setItems(buildItems())
    // setItems reconciles and measures; the content render pass is a separate
    // explicit kick (Pierre's own React wrapper does the same after seeding).
    instance.render(true)

    // CodeView's first render passes can no-op while its async dependencies
    // (highlighter/theme init) come up, and nothing re-renders when they
    // arrive -- interactive consumers get re-kicked by app state churn this
    // surface deliberately does not have. Re-kick with decaying retries until
    // the first item actually holds content, and again on root resizes (the
    // panel animates open and can present a zero-size root at mount).
    const hasRenderedContent = () => {
      const first = instance.getRenderedItems()[0]
      return !!first && (first.element.shadowRoot?.childElementCount ?? 0) > 1
    }
    let kickTimer: ReturnType<typeof setTimeout> | undefined
    const kickUntilContent = (attempt = 0) => {
      if (hasRenderedContent() || attempt > 8) return
      instance.render(true)
      stampSoon()
      kickTimer = setTimeout(() => kickUntilContent(attempt + 1), 50 * (attempt + 1))
    }
    let lastKickHeight = -1
    let resizeObserver: ResizeObserver | undefined
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver((entries) => {
        const height = entries.at(-1)?.contentRect.height ?? 0
        if (height === lastKickHeight) return
        lastKickHeight = height
        if (height > 0) {
          instance.render(true)
          stampSoon()
        }
      })
      resizeObserver.observe(host)
    }
    kickUntilContent()

    const scroller = findScroller(host)
    scroller.dataset.scrollable = "true"
    // `host` carries `overflow: auto` inline, so the search settles on it and the ref is
    // the root div. `scrollRef` is declared as an HTMLDivElement callback by its app-side
    // consumers, so a deeper non-div scroller falls back to the root rather than lying.
    props.scrollRef?.(scroller instanceof HTMLDivElement ? scroller : host)
    // The engine's scroller is only typed `HTMLElement`; when it is not the root
    // div the ref above already reports `host` instead, so the two would disagree
    // about which element the caller is tracking. Forwarding only the checked
    // events keeps the scroll stream and the ref describing the same element.
    const forwardScroll = (event: Event) => {
      if (isDivScrollEvent(event)) props.onScrollEvent?.(event)
    }
    scroller.addEventListener("scroll", forwardScroll, { passive: true })
    const unsubscribe = instance.subscribeToScroll(() => stampSoon())
    stampSoon()

    onCleanup(() => {
      if (kickTimer) clearTimeout(kickTimer)
      resizeObserver?.disconnect()
      unsubscribe()
      scroller.removeEventListener("scroll", forwardScroll)
      if (stampFrame !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(stampFrame)
      instance.cleanUp()
      headerHosts.clear()
      view = undefined
    })
  })

  createEffect(on(
    () => props.diffs,
    (_next, previous) => {
      if (previous === undefined) return
      generation += 1
      view?.setItems(buildItems())
      view?.render()
      stampSoon()
    },
  ))

  createEffect(on(
    () => props.open.join("\0"),
    (_next, previous) => {
      if (previous === undefined) return
      view?.setItems(buildItems())
      view?.render()
      stampSoon()
    },
  ))

  createEffect(on(
    () => props.diffStyle,
    (style, previous) => {
      if (previous === undefined) return
      view?.setOptions({ diffStyle: style })
      stampSoon()
    },
  ))

  return (
    <div
      ref={root}
      data-component="session-review"
      data-slot="session-review-scroll"
      class={props.class}
      style={{ height: "100%", "min-height": "0", overflow: "auto", position: "relative" }}
    >
      <For each={headerFiles()}>
        {(file) => (
          <Portal mount={headerHosts.get(file)}>
            {/* The accordion structure the review header CSS is written
                against; the engine's slot replaces the accordion's layout
                role, this chain only carries the styling contract. */}
            <div data-component="accordion" class="ui-accordion">
              <div
                data-slot="accordion-item" class="ui-accordion-item"
                data-review-header-file={file}
                data-expanded={expanded(file) ? "" : undefined}
                data-selected={props.focusedFile === file ? "" : undefined}
              >
                <div data-slot="accordion-header">
                  <button
                    type="button"
                    data-slot="accordion-trigger"
                    class="ui-accordion-trigger"
                    data-testid={props.headerTestId?.(file) ?? "review-codeview-trigger"}
                    aria-expanded={expanded(file) ? "true" : "false"}
                    aria-label={`Toggle diff for ${file}`}
                    onClick={() => props.onToggleOpen?.(file)}
                  >
                    {props.renderHeader?.(file)}
                  </button>
                </div>
              </div>
            </div>
          </Portal>
        )}
      </For>
    </div>
  )
}
