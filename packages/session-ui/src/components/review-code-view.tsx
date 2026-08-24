/**
 * ReviewCodeView — stage-1 spike of the Review surface on Pierre's CodeView.
 *
 * One CodeView instance owns the whole changed-file document: layout,
 * virtualization, scrolling, worker-pool highlighting. This component is the
 * Solid boundary around that imperative engine: it maps the review model
 * (files + expansion) onto controlled `CodeViewItem`s and exposes the scroll
 * element to the caller's scroll-restoration machinery.
 *
 * Spike scope, deliberately: no line comments, no gutter, no custom header
 * chrome — Pierre's default headers render, and a transparent light-DOM strip
 * over each header carries the expand/collapse affordance plus the
 * `data-review-file` / `aria-expanded` markers the app's tooling and the
 * perf-harness identity gates read. The strip is throwaway compat scaffolding
 * for the spike, not the target header design.
 */
import { CodeView, type CodeViewDiffItem, type CodeViewOptions } from "@pierre/diffs"
import { createEffect, on, onCleanup, onMount } from "solid-js"

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
  /** Receives the live scroll element for scroll capture/restoration. */
  scrollRef?: (element: HTMLDivElement) => void
  /** Native scroll events from the scroll element. */
  onScrollEvent?: (event: Event) => void
  /** Fired after CodeView commits a render pass with visible content. */
  onDiffRendered?: () => void
  class?: string
}

const STRIP_HEIGHT_PX = 36

export function ReviewCodeView(props: ReviewCodeViewProps) {
  let root: HTMLDivElement | undefined
  let view: CodeView<undefined> | undefined
  let generation = 0
  let stampFrame: number | undefined

  const openSet = () => new Set(props.open)

  const buildItems = (): CodeViewDiffItem<undefined>[] => {
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
   * `data-review-file` identity the app's tooling queries, and the header
   * strip carrying expansion state and the toggle. Shadow DOM stays Pierre's.
   */
  const stamp = () => {
    stampFrame = undefined
    const current = view
    const host = root
    if (!current || !host) return
    const open = openSet()
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
        element.style.position = "relative"
        element.style.minHeight = "1px"
      }
      let strip = element.querySelector<HTMLButtonElement>(":scope > [data-review-codeview-strip]")
      if (!strip) {
        strip = document.createElement("button")
        strip.type = "button"
        strip.dataset.reviewCodeviewStrip = ""
        strip.dataset.testid = "review-codeview-trigger"
        strip.setAttribute("aria-label", `Toggle diff for ${record.id}`)
        strip.style.cssText =
          `position:absolute;top:0;left:0;right:0;height:${STRIP_HEIGHT_PX}px;` +
          "background:transparent;border:0;padding:0;margin:0;cursor:pointer;z-index:1;"
        strip.addEventListener("click", () => props.onToggleOpen?.(record.id))
        element.append(strip)
      }
      strip.setAttribute("aria-expanded", open.has(record.id) ? "true" : "false")
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
      onPostRender: () => {
        props.onDiffRendered?.()
        stampSoon()
      },
    }
    const instance = new CodeView(options, getWorkerPool(props.diffStyle), true)
    view = instance
    instance.setup(host)
    instance.setItems(buildItems())

    const scroller = findScroller(host)
    scroller.dataset.scrollable = "true"
    props.scrollRef?.(scroller as HTMLDivElement)
    const forwardScroll = (event: Event) => props.onScrollEvent?.(event)
    scroller.addEventListener("scroll", forwardScroll, { passive: true })
    const unsubscribe = instance.subscribeToScroll(() => stampSoon())
    stampSoon()

    onCleanup(() => {
      unsubscribe()
      scroller.removeEventListener("scroll", forwardScroll)
      if (stampFrame !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(stampFrame)
      instance.cleanUp()
      view = undefined
    })
  })

  createEffect(on(
    () => props.diffs,
    (_next, previous) => {
      if (previous === undefined) return
      generation += 1
      view?.setItems(buildItems())
      stampSoon()
    },
  ))

  createEffect(on(
    () => props.open.join("\0"),
    (_next, previous) => {
      if (previous === undefined) return
      view?.setItems(buildItems())
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
    />
  )
}
