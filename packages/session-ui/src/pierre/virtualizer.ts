import { type VirtualFileMetrics, Virtualizer, type VirtualizerConfig } from "@pierre/diffs"

type Target = {
  owner: Document | HTMLElement
  variant: "default" | "inline-diff"
  root: Document | HTMLElement
  content: HTMLElement | undefined
  config?: Partial<VirtualizerConfig>
}

type Entry = {
  virtualizer: Virtualizer
  refs: number
}

const cache = new WeakMap<Document | HTMLElement, Map<Target["variant"], Entry>>()

export const virtualMetrics: Partial<VirtualFileMetrics> = {
  lineHeight: 24,
  hunkSeparatorHeight: 24,
  spacing: 0,
}

/**
 * Rows a panel-hosted virtual view keeps around the visible range.
 *
 * Pierre's 1000px default buffer is sized for a full-page viewport: its window
 * is `viewportHeight + 2 * overscrollSize`, so inside an ~860px panel scroller
 * the first render materializes roughly three times the rows the reader can
 * see. Every surface below draws into a panel scroller, so all of them retain
 * ten lines instead and let the virtualizer grow the window from there without
 * rebuilding what it already drew.
 */
export const PANEL_OVERSCROLL_SIZE = (virtualMetrics.lineHeight ?? 24) * 10

function scrollable(value: string) {
  return value === "auto" || value === "scroll" || value === "overlay"
}

function scrollRoot(container: HTMLElement) {
  let node = container.parentElement
  while (node) {
    const style = getComputedStyle(node)
    if (scrollable(style.overflowY)) return node
    node = node.parentElement
  }
}

function target(container: HTMLElement): Target | undefined {
  if (typeof document === "undefined") return

  const review = container.closest("[data-component='session-review']")
  if (review instanceof HTMLElement) {
    const root = scrollRoot(container) ?? review
    const content = review.querySelector("[data-slot='session-review-container']")
    return {
      owner: review,
      variant: "default",
      root,
      content: content instanceof HTMLElement ? content : undefined,
      config: { overscrollSize: PANEL_OVERSCROLL_SIZE },
    }
  }

  const root = scrollRoot(container)
  if (root) {
    const content = root.querySelector("[role='log']")
    const inlineDiff = !!container.closest("[data-component='edit-content'], [data-component='apply-patch-file-diff']")
    return {
      owner: root,
      variant: inlineDiff ? "inline-diff" : "default",
      root,
      content: content instanceof HTMLElement ? content : undefined,
      config: inlineDiff ? { overscrollSize: PANEL_OVERSCROLL_SIZE } : undefined,
    }
  }

  return {
    owner: document,
    variant: "default",
    root: document,
    content: undefined,
  }
}

export function acquireVirtualizer(container: HTMLElement) {
  const resolved = target(container)
  if (!resolved) return

  let entries = cache.get(resolved.owner)
  if (!entries) {
    entries = new Map()
    cache.set(resolved.owner, entries)
  }
  let entry = entries.get(resolved.variant)
  if (!entry) {
    const virtualizer = new Virtualizer(resolved.config)
    virtualizer.setup(resolved.root, resolved.content)
    entry = {
      virtualizer,
      refs: 0,
    }
    entries.set(resolved.variant, entry)
  }

  entry.refs += 1
  let done = false

  return {
    virtualizer: entry.virtualizer,
    release() {
      if (done) return
      done = true

      const ownerEntries = cache.get(resolved.owner)
      const current = ownerEntries?.get(resolved.variant)
      if (!current) return

      current.refs -= 1
      if (current.refs > 0) return

      current.virtualizer.cleanUp()
      ownerEntries!.delete(resolved.variant)
      if (ownerEntries!.size === 0) cache.delete(resolved.owner)
    },
  }
}
