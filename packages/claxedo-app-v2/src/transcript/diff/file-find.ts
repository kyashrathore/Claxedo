import { createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { createStore } from "solid-js/store"
import { assignFindRanges, fileFindMatches, fileFindMatchesByLine, type FileFindMatch } from "./file-find-content"
import { scrollParent } from "./file-runtime"

export type FindHost = {
  element: () => HTMLElement | undefined
  open: () => void
  close: () => void
  next: (dir: 1 | -1) => void
  isOpen: () => boolean
}

const REVEAL_SETTLE_FRAMES = 10

const hosts = new Set<FindHost>()
let target: FindHost | undefined
let current: FindHost | undefined
let installed = false

function isEditable(node: unknown): boolean {
  if (!(node instanceof HTMLElement)) return false
  if (node.closest("[data-prevent-autofocus]")) return true
  if (node.isContentEditable) return true
  return /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(node.tagName)
}

function hostForNode(node: unknown): FindHost | undefined {
  if (!(node instanceof Node)) return undefined
  for (const host of hosts) {
    const el = host.element()
    if (el && el.isConnected && el.contains(node)) return host
  }
  return undefined
}

function installShortcuts() {
  if (installed) return
  if (typeof window === "undefined") return
  installed = true

  window.addEventListener(
    "keydown",
    (event) => {
      if (event.defaultPrevented) return
      if (isEditable(event.target)) return

      const mod = event.metaKey || event.ctrlKey
      if (!mod) return

      const key = event.key.toLowerCase()
      if (key === "g") {
        const host = current
        if (!host || !host.isOpen()) return
        event.preventDefault()
        event.stopPropagation()
        host.next(event.shiftKey ? -1 : 1)
        return
      }

      if (key !== "f") return

      const active = current
      if (active && active.isOpen()) {
        event.preventDefault()
        event.stopPropagation()
        active.open()
        return
      }

      const host = hostForNode(document.activeElement) ?? hostForNode(event.target) ?? target ?? Array.from(hosts)[0]
      if (!host) return

      event.preventDefault()
      event.stopPropagation()
      host.open()
    },
    { capture: true },
  )
}

const FIND_HIGHLIGHT = "opencode-find"
const FIND_HIGHLIGHT_CURRENT = "opencode-find-current"

function highlightRegistry(): HighlightRegistry | undefined {
  if (typeof CSS === "undefined" || typeof Highlight !== "function") return undefined
  return CSS.highlights
}

function clearHighlightFind() {
  const api = highlightRegistry()
  if (!api) return
  api.delete(FIND_HIGHLIGHT)
  api.delete(FIND_HIGHLIGHT_CURRENT)
}

function supportsHighlights() {
  return highlightRegistry() !== undefined
}

type CreateFileFindOptions = {
  wrapper: () => HTMLElement | undefined
  overlay: () => HTMLDivElement | undefined
  getRoot: () => ShadowRoot | undefined
  lines?: () => readonly string[] | undefined
  revealLine?: (line: number) => void
}

export function createFileFind(opts: CreateFileFindOptions) {
  let input: HTMLInputElement | undefined
  let overlayFrame: number | undefined
  let mode: "highlights" | "overlay" = "overlay"
  let hits: Array<Range | undefined> = []
  let matches: FileFindMatch[] = []
  let scrollWhenRevealed = false
  let revealFrame: number | undefined
  let revealFramesLeft = 0
  let windowFrame: number | undefined
  const [overlayScroll, setOverlayScroll] = createSignal<HTMLElement[]>([])

  const [state, setState] = createStore({
    open: false,
    query: "",
    index: 0,
    count: 0,
    pos: { top: 8, right: 8 },
  })
  const open = () => state.open
  const query = () => state.query
  const index = () => state.index
  const count = () => state.count
  const pos = () => state.pos

  const clearOverlayScroll = () => {
    setOverlayScroll([])
  }

  const clearOverlay = () => {
    const el = opts.overlay()
    if (!el) return
    if (overlayFrame !== undefined) {
      cancelAnimationFrame(overlayFrame)
      overlayFrame = undefined
    }
    el.innerHTML = ""
  }

  const renderOverlay = () => {
    if (mode !== "overlay") {
      clearOverlay()
      return
    }

    const wrapper = opts.wrapper()
    const overlay = opts.overlay()
    if (!wrapper || !overlay) return

    clearOverlay()
    if (hits.length === 0) return

    const base = wrapper.getBoundingClientRect()
    const currentIndex = index()
    const frag = document.createDocumentFragment()

    for (let i = 0; i < hits.length; i++) {
      const range = hits[i]
      if (!range) continue
      const active = i === currentIndex
      for (const rect of Array.from(range.getClientRects())) {
        if (!rect.width || !rect.height) continue

        const mark = document.createElement("div")
        mark.style.position = "absolute"
        mark.style.left = `${Math.round(rect.left - base.left)}px`
        mark.style.top = `${Math.round(rect.top - base.top)}px`
        mark.style.width = `${Math.round(rect.width)}px`
        mark.style.height = `${Math.round(rect.height)}px`
        mark.style.borderRadius = "var(--radius-xs)"
        mark.style.backgroundColor = active ? "var(--surface-warning-strong)" : "var(--surface-warning-base)"
        mark.style.opacity = active ? "0.55" : "0.35"
        if (active) mark.style.boxShadow = "inset 0 0 0 1px var(--border-warning-base)"
        frag.appendChild(mark)
      }
    }

    overlay.appendChild(frag)
  }

  function scheduleOverlay() {
    if (mode !== "overlay") return
    if (!open()) return
    if (overlayFrame !== undefined) return

    overlayFrame = requestAnimationFrame(() => {
      overlayFrame = undefined
      renderOverlay()
    })
  }

  const syncOverlayScroll = () => {
    if (mode !== "overlay") return
    const root = opts.getRoot()

    const next = root
      ? Array.from(root.querySelectorAll("[data-code]")).filter(
          (node): node is HTMLElement => node instanceof HTMLElement,
        )
      : []
    const current = overlayScroll()
    if (next.length === current.length && next.every((el, i) => el === current[i])) return

    clearOverlayScroll()
    setOverlayScroll(next)
  }

  const clearFind = () => {
    clearHighlightFind()
    clearOverlay()
    clearOverlayScroll()
    hits = []
    matches = []
    scrollWhenRevealed = false
    setState("count", 0)
    setState("index", 0)
  }

  const positionBar = () => {
    if (typeof window === "undefined") return
    const wrapper = opts.wrapper()
    if (!wrapper) return

    const root = scrollParent(wrapper) ?? wrapper
    const rect = root.getBoundingClientRect()
    const title = parseFloat(getComputedStyle(root).getPropertyValue("--session-title-height"))
    const header = Number.isNaN(title) ? 0 : title

    setState("pos", {
      top: Math.round(rect.top) + header - 4,
      right: Math.round(window.innerWidth - rect.right) + 8,
    })
  }

  const renderedRows = (root: ShadowRoot) =>
    Array.from(root.querySelectorAll("[data-content] [data-line], [data-column-content]")).filter(
      (node): node is HTMLElement => node instanceof HTMLElement,
    )

  const scanRow = (col: HTMLElement, value: string) => {
    const needle = value.toLowerCase()
    const ranges: Range[] = []
    const text = col.textContent
    if (!text) return ranges

    const hay = text.toLowerCase()
    let at = hay.indexOf(needle)
    if (at === -1) return ranges

    const nodes: Text[] = []
    const ends: number[] = []
    const walker = document.createTreeWalker(col, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    let pos = 0
    while (node) {
      if (node instanceof Text) {
        pos += node.data.length
        nodes.push(node)
        ends.push(pos)
      }
      node = walker.nextNode()
    }
    if (nodes.length === 0) return ranges

    const locate = (offset: number) => {
      let lo = 0
      let hi = ends.length - 1
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (ends[mid] >= offset) hi = mid
        else lo = mid + 1
      }
      const prev = lo === 0 ? 0 : ends[lo - 1]
      return { node: nodes[lo], offset: offset - prev }
    }

    while (at !== -1) {
      const start = locate(at)
      const end = locate(at + value.length)
      const range = document.createRange()
      range.setStart(start.node, start.offset)
      range.setEnd(end.node, end.offset)
      ranges.push(range)
      at = hay.indexOf(needle, at + value.length)
    }

    return ranges
  }

  const scan = (root: ShadowRoot, value: string) =>
    renderedRows(root).flatMap((col) => scanRow(col, value))

  const scanWindowed = (root: ShadowRoot, value: string, lines: readonly string[]) => {
    const found = fileFindMatches(lines, value)
    if (found.length === 0) return { found, ranges: [] as Array<Range | undefined> }

    const byLine = fileFindMatchesByLine(found)
    const rows = renderedRows(root)
      .map((row) => ({ line: Number(row.dataset.line), ranges: scanRow(row, value) }))
      .filter((row) => Number.isFinite(row.line) && byLine.has(row.line))

    return { found, ranges: assignFindRanges(found.length, byLine, rows) }
  }

  const scrollToRange = (range: Range) => {
    const start = range.startContainer
    const el = start instanceof Element ? start : start.parentElement
    el?.scrollIntoView({ block: "center", inline: "center" })
  }

  const setHighlights = (ranges: Array<Range | undefined>, currentIndex: number) => {
    const api = highlightRegistry()
    if (!api) return false

    clearHighlightFind()

    const active = ranges[currentIndex]
    if (active) api.set(FIND_HIGHLIGHT_CURRENT, new Highlight(active))

    const rest = ranges.filter((range, i): range is Range => range !== undefined && i !== currentIndex)
    if (rest.length > 0) api.set(FIND_HIGHLIGHT, new Highlight(...rest))
    return true
  }

  const apply = (args?: { reset?: boolean; scroll?: boolean }) => {
    if (!open()) return

    const value = query().trim()
    if (!value) {
      clearFind()
      return
    }

    const root = opts.getRoot()
    if (!root) return

    mode = supportsHighlights() ? "highlights" : "overlay"

    const lines = opts.lines?.()
    const windowed = lines ? scanWindowed(root, value, lines) : undefined
    const ranges = windowed ? windowed.ranges : scan(root, value)
    matches = windowed ? windowed.found : []
    const total = ranges.length
    const desired = args?.reset ? 0 : index()
    const currentIndex = total ? Math.min(desired, total - 1) : 0

    hits = ranges
    setState("count", total)
    setState("index", currentIndex)

    const active = ranges[currentIndex]
    const wantsScroll = args?.scroll === true || scrollWhenRevealed
    if (wantsScroll && !active && total > 0) {
      const line = matches[currentIndex]?.line
      if (line === undefined || !revealMatchLine(line)) scrollWhenRevealed = false
    } else if (wantsScroll && active) {
      scrollWhenRevealed = false
    }

    if (mode === "highlights") {
      clearOverlay()
      clearOverlayScroll()
      if (!setHighlights(ranges, currentIndex)) {
        mode = "overlay"
        clearHighlightFind()
        syncOverlayScroll()
        scheduleOverlay()
      }
      if (wantsScroll && active) scrollToRange(active)
      return
    }

    clearHighlightFind()
    syncOverlayScroll()
    if (wantsScroll && active) scrollToRange(active)
    scheduleOverlay()
  }

  const stopRevealPump = () => {
    if (revealFrame !== undefined) cancelAnimationFrame(revealFrame)
    revealFrame = undefined
    revealFramesLeft = 0
    if (windowFrame !== undefined) cancelAnimationFrame(windowFrame)
    windowFrame = undefined
  }

  const pumpWindow = () => {
    if (windowFrame !== undefined) return
    if (typeof requestAnimationFrame === "undefined") return
    windowFrame = requestAnimationFrame(() => {
      windowFrame = undefined
      if (!open()) return
      apply()
    })
  }

  const pumpReveal = () => {
    if (revealFrame !== undefined) return
    if (typeof requestAnimationFrame === "undefined") return
    revealFrame = requestAnimationFrame(() => {
      revealFrame = undefined
      if (!open() || !scrollWhenRevealed) return
      apply()
      if (scrollWhenRevealed && revealFramesLeft > 0) {
        revealFramesLeft -= 1
        pumpReveal()
      }
    })
  }

  const revealMatchLine = (line: number) => {
    if (!opts.revealLine) return false
    scrollWhenRevealed = true
    revealFramesLeft = REVEAL_SETTLE_FRAMES
    opts.revealLine(line)
    pumpReveal()
    return true
  }

  const close = () => {
    setState("open", false)
    setState("query", "")
    stopRevealPump()
    clearFind()
    if (current === host) current = undefined
  }

  const focus = () => {
    if (current && current !== host) current.close()
    current = host
    target = host
    if (!open()) setState("open", true)
    requestAnimationFrame(() => {
      apply({ scroll: true })
      input?.focus()
      input?.select()
    })
  }

  const next = (dir: 1 | -1) => {
    if (!open()) return
    const total = count()
    if (total <= 0) return

    const currentIndex = (index() + dir + total) % total
    setState("index", currentIndex)

    const active = hits[currentIndex]
    if (!active) {
      const line = matches[currentIndex]?.line
      if (line !== undefined) revealMatchLine(line)
      return
    }

    if (mode === "highlights") {
      if (!setHighlights(hits, currentIndex)) {
        mode = "overlay"
        apply({ reset: true, scroll: true })
        return
      }
      scrollToRange(active)
      return
    }

    clearHighlightFind()
    syncOverlayScroll()
    scrollToRange(active)
    scheduleOverlay()
  }

  const host: FindHost = {
    element: opts.wrapper,
    isOpen: () => open(),
    next,
    open: focus,
    close,
  }

  createEffect(() => {
    for (const el of overlayScroll()) makeEventListener(el, "scroll", scheduleOverlay, { passive: true })
  })

  onMount(() => {
    mode = supportsHighlights() ? "highlights" : "overlay"
    installShortcuts()
    hosts.add(host)
    if (!target) target = host

    onCleanup(() => {
      hosts.delete(host)
      if (current === host) {
        current = undefined
        clearHighlightFind()
      }
      if (target === host) target = undefined
    })
  })

  createEffect(() => {
    if (!open()) return

    const update = () => positionBar()
    requestAnimationFrame(update)
    makeEventListener(window, "resize", update, { passive: true })

    const wrapper = opts.wrapper()
    if (!wrapper) return
    const root = scrollParent(wrapper) ?? wrapper
    createResizeObserver(root, update)

    if (!opts.lines) return
    makeEventListener(root, "scroll", () => pumpWindow(), { passive: true })
  })

  onCleanup(() => {
    stopRevealPump()
    clearOverlayScroll()
    clearOverlay()
    if (current === host) {
      current = undefined
      clearHighlightFind()
    }
  })

  return {
    open,
    query,
    count,
    index,
    pos,
    setInput: (el: HTMLInputElement) => {
      input = el
    },
    setQuery: (value: string) => {
      setState("query", value)
      setState("index", 0)
      scrollWhenRevealed = false
      stopRevealPump()
      apply({ reset: true, scroll: true })
    },
    focus,
    close,
    next,
    refresh: (args?: { reset?: boolean; scroll?: boolean }) => apply(args),
    onPointerDown: () => {
      target = host
      opts.wrapper()?.focus({ preventScroll: true })
    },
    onFocus: () => {
      target = host
    },
    onInputKeyDown: (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        close()
        return
      }
      if (event.key !== "Enter") return
      event.preventDefault()
      next(event.shiftKey ? -1 : 1)
    },
  }
}
