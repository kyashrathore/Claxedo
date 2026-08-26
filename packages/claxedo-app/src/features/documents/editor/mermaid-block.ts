/**
 * Mermaid Code Block — Extended Tiptap CodeBlock with mermaid diagram rendering
 *
 * Non-mermaid code blocks render as default <pre><code>.
 * Mermaid blocks get a toolbar (toggle code/diagram, copy, fullscreen)
 * and diagram preview with zoom controls.
 */

import { CodeBlock } from "@tiptap/extension-code-block"
import { mermaidKeyAction } from "./mermaid-keyboard"

// ── Lazy mermaid loader (matches pattern from @opencode-ai/ui) ──────

let mermaidModule: Promise<typeof import("mermaid")> | null = null
let mermaidId = 0

function getMermaid() {
  if (!mermaidModule) {
    mermaidModule = import("mermaid")
      .then((m) => {
        m.default.initialize({ startOnLoad: false, securityLevel: "strict" })
        return m
      })
      .catch((e) => {
        mermaidModule = null
        throw e
      })
  }
  return mermaidModule
}

async function renderMermaid(source: string): Promise<string> {
  const m = await getMermaid()
  return (await m.default.render(`mermaid-pg-${++mermaidId}`, source)).svg
}

// ── SVG icon helpers ────────────────────────────────────────────────

function icon(pathD: string, size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${pathD}</svg>`
}

const icons = {
  code: icon('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'),
  diagram: icon(
    '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
  ),
  copy: icon(
    '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  ),
  check: icon('<polyline points="20 6 9 17 4 12"/>'),
  fullscreen: icon(
    '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>',
  ),
  close: icon('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  zoomIn: icon(
    '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>',
  ),
  zoomOut: icon(
    '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/>',
  ),
  zoomReset: icon('<path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>'),
  trash: icon(
    '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  ),
}

// ── Helpers ─────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string>,
  children?: (Node | string)[],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  if (children) for (const c of children) node.append(typeof c === "string" ? document.createTextNode(c) : c)
  return node
}

function btn(className: string, title: string, innerHTML: string, onClick: () => void) {
  const b = el("button", { class: className, type: "button", title })
  b.innerHTML = innerHTML
  b.addEventListener("mousedown", (e) => e.preventDefault())
  b.addEventListener("click", (e) => {
    e.preventDefault()
    e.stopPropagation()
    onClick()
  })
  return b
}

function errorMessage(input: unknown, fallback: string) {
  return input instanceof Error ? input.message : fallback
}

// ── Pan/zoom controller ─────────────────────────────────────────────

interface PanZoomState {
  zoom: number
  panX: number
  panY: number
}

function applyTransform(container: HTMLElement, state: PanZoomState) {
  container.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`
  container.style.transformOrigin = "0 0"
}

/**
 * Attaches wheel-to-zoom + drag-to-pan on a viewport element.
 * Transform is applied to `target` (the SVG wrapper), viewport clips overflow.
 * Returns { state, setZoom, resetView, destroy }.
 */
function attachPanZoom(viewport: HTMLElement, target: HTMLElement) {
  const state: PanZoomState = { zoom: 1, panX: 0, panY: 0 }
  let dragging = false
  let lastX = 0
  let lastY = 0

  function apply() {
    applyTransform(target, state)
  }

  function setZoom(z: number) {
    state.zoom = Math.max(0.1, Math.min(z, 10))
    apply()
  }

  function resetView() {
    state.zoom = 1
    state.panX = 0
    state.panY = 0
    apply()
  }

  // Multiply zoom by `factor`, keeping the point (cx, cy) fixed on screen.
  function zoomAt(factor: number, cx: number, cy: number) {
    const oldZoom = state.zoom
    const newZoom = Math.max(0.1, Math.min(oldZoom * factor, 10))
    state.panX = cx - (cx - state.panX) * (newZoom / oldZoom)
    state.panY = cy - (cy - state.panY) * (newZoom / oldZoom)
    state.zoom = newZoom
    apply()
  }

  // Wheel → zoom, centered on cursor (only with Ctrl/Meta held)
  function onWheel(e: WheelEvent) {
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    const rect = viewport.getBoundingClientRect()
    zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - rect.left, e.clientY - rect.top)
  }

  // Keyboard equivalents for wheel-zoom and drag-pan, so the diagram is
  // operable without a pointer. Keyboard zoom centers on the viewport middle.
  function onKeyDown(e: KeyboardEvent) {
    const action = mermaidKeyAction(e.key)
    if (!action) return
    e.preventDefault()
    if (action.type === "zoom") {
      const rect = viewport.getBoundingClientRect()
      zoomAt(action.factor, rect.width / 2, rect.height / 2)
    } else if (action.type === "reset") {
      resetView()
    } else {
      state.panX += action.dx
      state.panY += action.dy
      apply()
    }
  }

  // Mouse drag → pan (with threshold to allow click-to-select)
  const DRAG_THRESHOLD = 4
  let pending = false
  let startX = 0
  let startY = 0

  function onPointerDown(e: PointerEvent) {
    const target = e.target instanceof HTMLElement ? e.target : undefined
    if (target?.closest("button")) return
    pending = true
    dragging = false
    startX = e.clientX
    startY = e.clientY
    lastX = e.clientX
    lastY = e.clientY
  }

  function onPointerMove(e: PointerEvent) {
    if (!pending && !dragging) return
    if (pending && !dragging) {
      const dx = e.clientX - startX
      const dy = e.clientY - startY
      if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return
      // Exceeded threshold — start real drag
      dragging = true
      pending = false
      viewport.setPointerCapture(e.pointerId)
      viewport.style.cursor = "grabbing"
    }
    if (!dragging) return
    state.panX += e.clientX - lastX
    state.panY += e.clientY - lastY
    lastX = e.clientX
    lastY = e.clientY
    apply()
  }

  function onPointerUp(e: PointerEvent) {
    pending = false
    if (!dragging) return
    dragging = false
    viewport.releasePointerCapture(e.pointerId)
    viewport.style.cursor = ""
  }

  // Make the viewport keyboard-focusable and describe its keyboard controls.
  if (!viewport.hasAttribute("tabindex")) viewport.tabIndex = 0
  viewport.setAttribute(
    "aria-label",
    "Mermaid diagram. Press plus or minus to zoom, arrow keys to pan, 0 to reset the view.",
  )

  viewport.addEventListener("wheel", onWheel, { passive: false })
  viewport.addEventListener("pointerdown", onPointerDown)
  viewport.addEventListener("pointermove", onPointerMove)
  viewport.addEventListener("pointerup", onPointerUp)
  viewport.addEventListener("pointercancel", onPointerUp)
  viewport.addEventListener("keydown", onKeyDown)

  function destroy() {
    viewport.removeEventListener("wheel", onWheel)
    viewport.removeEventListener("pointerdown", onPointerDown)
    viewport.removeEventListener("pointermove", onPointerMove)
    viewport.removeEventListener("pointerup", onPointerUp)
    viewport.removeEventListener("pointercancel", onPointerUp)
    viewport.removeEventListener("keydown", onKeyDown)
  }

  return { state, setZoom, resetView, destroy }
}

// ── Extension ───────────────────────────────────────────────────────

export const MermaidCodeBlock = CodeBlock.extend({
  addNodeView() {
    return ({ node, getPos, editor }) => {
      const language = typeof node.attrs.language === "string" ? node.attrs.language : null

      // Non-mermaid: default rendering
      if (language !== "mermaid") {
        const pre = el("pre")
        const code = el("code", {
          class: node.attrs.language ? `language-${node.attrs.language}` : "",
          spellcheck: "false",
          autocorrect: "off",
          autocapitalize: "off",
        })
        pre.appendChild(code)
        return { dom: pre, contentDOM: code }
      }

      // ── Mermaid NodeView ─────────────────────────────────────

      let mode: "code" | "diagram" = "diagram"
      let renderTimer: ReturnType<typeof setTimeout> | null = null
      let copyTimer: ReturnType<typeof setTimeout> | null = null
      let lastRenderedSource = ""
      let renderRun = 0
      let closeFullscreen: (() => void) | undefined

      // DOM structure
      const dom = el("div", { class: "mermaid-block", contenteditable: "false" })

      // Toolbar
      const toolbar = el("div", { class: "mermaid-toolbar" })
      const langLabel = el("span", { class: "mermaid-lang-label" }, ["Mermaid"])

      const toggleBtn = btn("mermaid-btn", "Show code", icons.diagram, toggleMode)
      const copyBtn = btn("mermaid-btn", "Copy source", icons.copy, copySource)
      const fullscreenBtn = btn("mermaid-btn mermaid-btn-fullscreen", "Fullscreen", icons.fullscreen, openFullscreen)
      const deleteBtn = btn("mermaid-btn mermaid-btn-delete", "Delete block", icons.trash, deleteBlock)

      toolbar.append(langLabel, toggleBtn, copyBtn, fullscreenBtn, deleteBtn)

      // Code area (contentDOM — Tiptap manages this), hidden by default
      const pre = el("pre", { class: "mermaid-code" })
      pre.style.display = "none"
      const code = el("code", {
        spellcheck: "false",
        autocorrect: "off",
        autocapitalize: "off",
      })
      pre.appendChild(code)

      // Preview area — viewport clips, svgContainer gets transformed
      const preview = el("div", { class: "mermaid-preview" })

      const zoomControls = el("div", { class: "mermaid-zoom-controls" })
      const svgContainer = el("div", { class: "mermaid-svg" })
      const errorContainer = el("div", { class: "mermaid-error" })
      errorContainer.style.display = "none"

      preview.append(svgContainer, errorContainer, zoomControls)

      // Attach pan/zoom to inline preview
      const pz = attachPanZoom(preview, svgContainer)

      const zoomInBtn = btn("mermaid-zoom-btn", "Zoom in", icons.zoomIn, () => pz.setZoom(pz.state.zoom + 0.25))
      const zoomOutBtn = btn("mermaid-zoom-btn", "Zoom out", icons.zoomOut, () =>
        pz.setZoom(Math.max(0.25, pz.state.zoom - 0.25)),
      )
      const zoomResetBtn = btn("mermaid-zoom-btn", "Reset zoom", icons.zoomReset, () => pz.resetView())
      zoomControls.append(zoomOutBtn, zoomResetBtn, zoomInBtn)

      dom.append(toolbar, pre, preview)

      // Render initial diagram once Tiptap has populated the contentDOM
      requestAnimationFrame(() => renderDiagram())

      // ── Mode toggling ────────────────────────────────────────

      function toggleMode() {
        if (mode === "code") {
          mode = "diagram"
          pre.style.display = "none"
          preview.style.display = ""
          fullscreenBtn.style.display = ""
          toggleBtn.innerHTML = icons.diagram
          toggleBtn.title = "Show code"
          void renderDiagram()
        } else {
          mode = "code"
          pre.style.display = ""
          preview.style.display = "none"
          fullscreenBtn.style.display = "none"
          toggleBtn.innerHTML = icons.code
          toggleBtn.title = "Show diagram"
        }
      }

      // ── Rendering ────────────────────────────────────────────

      function getSource(): string {
        const pos = getPos()
        if (pos === undefined) return ""
        const resolved = editor.state.doc.resolve(pos + 1)
        return resolved.parent.textContent
      }

      async function renderDiagram() {
        const source = getSource().trim()
        const run = ++renderRun
        if (!source) {
          svgContainer.innerHTML = ""
          errorContainer.style.display = ""
          errorContainer.textContent = "Empty diagram"
          lastRenderedSource = ""
          return
        }
        if (source === lastRenderedSource) return

        try {
          const svg = await renderMermaid(source)
          if (run !== renderRun) return
          svgContainer.innerHTML = svg
          errorContainer.style.display = "none"
          lastRenderedSource = source
          pz.resetView()
        } catch (e: unknown) {
          if (run !== renderRun) return
          svgContainer.innerHTML = ""
          errorContainer.style.display = ""
          errorContainer.textContent = errorMessage(e, "Invalid mermaid syntax")
          lastRenderedSource = ""
        }
      }

      function scheduleRender() {
        if (mode !== "diagram") return
        if (renderTimer) clearTimeout(renderTimer)
        renderTimer = setTimeout(renderDiagram, 500)
      }

      // ── Delete ────────────────────────────────────────────────

      function deleteBlock() {
        const pos = getPos()
        if (pos === undefined) return
        const node = editor.state.doc.nodeAt(pos)
        if (!node) return
        editor
          .chain()
          .focus()
          .deleteRange({ from: pos, to: pos + node.nodeSize })
          .run()
      }

      // ── Copy ─────────────────────────────────────────────────

      function copySource() {
        const source = getSource()
        navigator.clipboard.writeText(source).then(
          () => {
            copyBtn.innerHTML = icons.check
            if (copyTimer) clearTimeout(copyTimer)
            copyTimer = setTimeout(() => {
              copyBtn.innerHTML = icons.copy
              copyTimer = null
            }, 1500)
          },
          (error) => {
            copyBtn.title = "Copy failed"
            copyBtn.setAttribute("aria-label", "Copy failed")
            console.error("[documents] Mermaid source copy failed", error)
          },
        )
      }

      // ── Fullscreen ───────────────────────────────────────────

      function openFullscreen() {
        const source = getSource().trim()
        if (!source) return

        closeFullscreen?.()
        const overlay = el("div", { class: "mermaid-fullscreen" })
        const closeBtn = btn("mermaid-fullscreen-close", "Close", icons.close, close)

        const fsViewport = el("div", { class: "mermaid-fullscreen-viewport" })
        const fsContent = el("div", { class: "mermaid-fullscreen-content" })
        fsViewport.appendChild(fsContent)

        // Pan/zoom for fullscreen
        const fsPz = attachPanZoom(fsViewport, fsContent)

        const fsZoomControls = el("div", { class: "mermaid-zoom-controls mermaid-fullscreen-zoom" })
        const fsZoomIn = btn("mermaid-zoom-btn", "Zoom in", icons.zoomIn, () => fsPz.setZoom(fsPz.state.zoom + 0.25))
        const fsZoomOut = btn("mermaid-zoom-btn", "Zoom out", icons.zoomOut, () =>
          fsPz.setZoom(Math.max(0.25, fsPz.state.zoom - 0.25)),
        )
        const fsZoomReset = btn("mermaid-zoom-btn", "Reset zoom", icons.zoomReset, () => fsPz.resetView())
        fsZoomControls.append(fsZoomOut, fsZoomReset, fsZoomIn)

        overlay.append(closeBtn, fsZoomControls, fsViewport)
        document.body.appendChild(overlay)

        let closed = false
        function close() {
          closed = true
          fsPz.destroy()
          overlay.remove()
          document.removeEventListener("keydown", onKeyDown)
          if (closeFullscreen === close) closeFullscreen = undefined
        }
        closeFullscreen = close

        const onKeyDown = (e: KeyboardEvent) => {
          if (e.key === "Escape") close()
        }
        document.addEventListener("keydown", onKeyDown)

        // Render into fullscreen
        renderMermaid(source)
          .then((svg) => {
            if (closed) return
            fsContent.innerHTML = svg
          })
          .catch((e: unknown) => {
            if (closed) return
            fsContent.textContent = errorMessage(e, "Render failed")
            fsContent.classList.add("mermaid-error")
          })
      }

      // ── NodeView interface ───────────────────────────────────

      return {
        dom,
        contentDOM: code,
        update(updatedNode) {
          if (updatedNode.type.name !== "codeBlock") return false
          if (updatedNode.attrs.language !== "mermaid") return false
          scheduleRender()
          return true
        },
        stopEvent(event) {
          const target = event.target instanceof HTMLElement ? event.target : undefined
          // Stop button clicks so ProseMirror doesn't interfere
          if (target?.closest?.("button")) return true
          // Stop wheel events in preview only when Ctrl/Meta is held (zoom)
          if (event instanceof WheelEvent && target?.closest?.(".mermaid-preview") && (event.ctrlKey || event.metaKey))
            return true
          // Stop all events in fullscreen overlay (it's outside the editor)
          if (target?.closest?.(".mermaid-fullscreen")) return true
          // Let everything else through — ProseMirror handles click-to-select
          return false
        },
        ignoreMutation(mutation) {
          // Ignore mutations in the preview/toolbar — only code content matters
          if (code.contains(mutation.target)) return false
          return true
        },
        destroy() {
          if (renderTimer) clearTimeout(renderTimer)
          if (copyTimer) clearTimeout(copyTimer)
          closeFullscreen?.()
          pz.destroy()
        },
      }
    }
  },
})
