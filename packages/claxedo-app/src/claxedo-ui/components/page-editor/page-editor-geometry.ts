/**
 * Floating-panel geometry for the page editor.
 *
 * Computes toolbar/AI-panel anchor positions from the live editor view and
 * the `.notion-page-shell` bounds. Factory receives the Tiptap editor as an
 * accessor (never constructs or stores its own) plus the editor host element
 * and the selection/overlay accessors it needs. Extracted verbatim from
 * page-editor.tsx (Plan 005); no logic changes.
 */

import type { Editor } from "@tiptap/core"
import type { TiptapDeps } from "./page-editor-tiptap"
import { getTopLevelAt, calcAnchoredPopover, type AiPanelPos, type AiSelection } from "./page-editor-utils"

export type PageEditorGeometryDeps = {
  /** Singleton Tiptap editor owned by PageEditorLoaded — accessor only. */
  editor: () => Editor | undefined
  /** The `.notion-editor` host element (assigned on mount). */
  editorEl: () => HTMLDivElement | undefined
  TextSelection: TiptapDeps["TextSelection"]
  aiAnchor: () => number | null
  getSelection: () => AiSelection | null
  clampRange: (range: AiSelection | null) => AiSelection | null
  toolbarPos: () => { x: number; y: number } | null
}

export function createPageEditorGeometry(deps: PageEditorGeometryDeps) {
  const { editor, editorEl, TextSelection, aiAnchor, getSelection, clampRange, toolbarPos } = deps

  const getPanelBounds = () => {
    if (typeof window === "undefined") return { left: 10, right: 1024 }
    const el = editorEl()
    if (!el) return { left: 10, right: window.innerWidth - 10 }
    const shell = el.closest(".notion-page-shell")
    if (!(shell instanceof HTMLElement)) return { left: 10, right: window.innerWidth - 10 }
    const rect = shell.getBoundingClientRect()
    return {
      left: Math.max(10, Math.round(rect.left)),
      right: Math.min(window.innerWidth - 10, Math.round(rect.right)),
    }
  }

  const getPanelWidth = () => {
    const bounds = getPanelBounds()
    return Math.max(280, Math.min(620, bounds.right - bounds.left))
  }

  const clampLeft = (x: number, width: number) => {
    if (typeof window === "undefined") return x
    const bounds = getPanelBounds()
    return Math.max(bounds.left, Math.min(x, bounds.right - width))
  }

  const getSafeTop = () => {
    if (typeof window === "undefined") return 12
    const el = editorEl()
    if (!el) return 12
    const shell = el.closest(".notion-page-shell")
    if (!(shell instanceof HTMLElement)) return 12
    return Math.max(12, Math.round(shell.getBoundingClientRect().top) + 8)
  }

  const anchorMetrics = (raw: number | null) => {
    const e = editor()
    if (!e || raw === null) return null
    const max = e.state.doc.content.size
    const pos = Math.max(1, Math.min(raw, max))
    const info = getTopLevelAt(e, pos)
    const startPos = info ? info.list[info.index].pos + 1 : pos
    const endPos = info
      ? Math.max(startPos, Math.min(info.list[info.index].pos + info.list[info.index].nodeSize - 2, max))
      : startPos
    const start = e.view.coordsAtPos(startPos)
    const end = e.view.coordsAtPos(endPos)
    return {
      left: start.left,
      top: Math.min(start.top, end.top),
      bottom: Math.max(start.bottom, end.bottom),
    }
  }

  const computeToolbarPos = () => {
    const e = editor()
    if (!e) return null

    const selection = e.state.selection
    if (!(selection instanceof TextSelection)) return null

    if (selection.empty) {
      if (!e.isActive("table")) return null
      const point = e.view.coordsAtPos(selection.from)
      const safeTop = getSafeTop()
      const above = point.top - 48
      const below = point.bottom + 8
      const info = getTopLevelAt(e, selection.from)
      const edge = info ? e.view.coordsAtPos(info.list[info.index].pos + 1).left : point.left
      let y = above < safeTop ? below : above
      if (typeof window !== "undefined") y = Math.min(y, window.innerHeight - 42)
      return {
        x: clampLeft(edge, 420),
        y: Math.max(safeTop, y),
      }
    }

    const { from, to } = selection
    const selected = e.state.doc
      .textBetween(from, to, "\n", "\n")
      .replace(/\u200b/g, "")
      .trim()
    if (!selected) return null

    const start = e.view.coordsAtPos(from)
    const end = e.view.coordsAtPos(to)
    const safeTop = getSafeTop()
    const above = Math.min(start.top, end.top) - 48
    const below = Math.max(start.bottom, end.bottom) + 8
    if (Math.max(start.bottom, end.bottom) < safeTop) return null
    const info = getTopLevelAt(e, from)
    const edge = info ? e.view.coordsAtPos(info.list[info.index].pos + 1).left : start.left
    let y = above < safeTop ? below : above
    if (typeof window !== "undefined") y = Math.min(y, window.innerHeight - 42)
    return {
      x: clampLeft(edge, 420),
      y: Math.max(safeTop, y),
    }
  }

  const computeAnchorPos = () => {
    const metrics = anchorMetrics(aiAnchor())
    if (!metrics) return null
    return {
      x: clampLeft(metrics.left, 420),
      y: Math.max(12, metrics.top - 48),
    }
  }

  const calcAiPanelPos = (anchor: { x: number; y: number } | null, estimate = 284): AiPanelPos | null => {
    if (!anchor) return null
    if (typeof window === "undefined") return { x: anchor.x, y: anchor.y + 12, width: 620 }
    const width = getPanelWidth()
    const bounds = getPanelBounds()
    return calcAnchoredPopover({
      anchor,
      width,
      estimate,
      viewport_height: window.innerHeight,
      bounds_left: bounds.left,
      bounds_right: bounds.right,
    })
  }

  const computeAiPanelAnchor = (range: AiSelection | null) => {
    const e = editor()
    if (!e) return null
    if (range) {
      const next = clampRange(range)
      if (next) {
        const top = anchorMetrics(next.from)
        const end = e.view.coordsAtPos(next.to)
        return { x: top ? top.left : end.left, y: end.bottom }
      }
    }
    const metrics = anchorMetrics(aiAnchor())
    if (metrics) return { x: metrics.left, y: metrics.bottom }
    const selection = getSelection()
    if (selection) {
      const active = anchorMetrics(selection.from)
      if (active) return { x: active.left, y: active.bottom }
    }
    const bar = toolbarPos() || computeToolbarPos()
    if (!bar) return null
    return { x: bar.x, y: bar.y + 42 }
  }

  const computePreviewPos = (range: AiSelection | null, fixed?: AiPanelPos | null) => {
    if (fixed) return fixed
    const next = calcAiPanelPos(computeAiPanelAnchor(range), 264)
    if (next) return next
    if (typeof window !== "undefined") {
      const width = Math.min(620, Math.max(280, window.innerWidth - 20))
      return {
        x: Math.max(10, Math.round((window.innerWidth - width) / 2)),
        y: Math.max(120, Math.round(window.innerHeight * 0.26)),
        width,
      }
    }
    return { x: 20, y: 140, width: 620 }
  }

  return {
    getPanelBounds,
    getPanelWidth,
    clampLeft,
    getSafeTop,
    anchorMetrics,
    computeToolbarPos,
    computeAnchorPos,
    calcAiPanelPos,
    computeAiPanelAnchor,
    computePreviewPos,
  }
}

export type PageEditorGeometry = ReturnType<typeof createPageEditorGeometry>
