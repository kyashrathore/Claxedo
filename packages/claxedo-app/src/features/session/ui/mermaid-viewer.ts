import "./mermaid-timeline.css"

const icons = {
  close:
    '<svg aria-hidden="true" viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8"/></svg>',
  drag:
    '<svg aria-hidden="true" viewBox="0 0 16 16"><path d="M5.5 7V4.5a1 1 0 0 1 2 0V7m0 0V3.5a1 1 0 0 1 2 0V7m0 0V4.5a1 1 0 0 1 2 0V9m0-1V6.5a1 1 0 0 1 2 0V10c0 2.2-1.8 4-4 4H8.2a4 4 0 0 1-3.1-1.5L2.7 9.6a1.1 1.1 0 0 1 1.6-1.5L5.5 9"/></svg>',
  minus: '<svg aria-hidden="true" viewBox="0 0 16 16"><path d="M3.5 8h9"/></svg>',
  plus: '<svg aria-hidden="true" viewBox="0 0 16 16"><path d="M3.5 8h9M8 3.5v9"/></svg>',
}

const ZOOM_STEP = 0.1
const WHEEL_ZOOM_FACTOR = 1.04

function button(label: string, icon: string, action: () => void) {
  const node = document.createElement("button")
  node.type = "button"
  node.title = label
  node.setAttribute("aria-label", label)
  node.innerHTML = icon
  node.addEventListener("click", action)
  return node
}

let closeActiveViewer: (() => void) | undefined

export function openMermaidViewer(
  source: string,
  renderDiagram: (source: string) => Promise<string>,
  sanitize: (svg: string) => string,
) {
  closeActiveViewer?.()

  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  const previousOverflow = document.body.style.overflow
  const overlay = document.createElement("div")
  const surface = document.createElement("div")
  const viewport = document.createElement("div")
  const content = document.createElement("div")
  const toolbar = document.createElement("div")
  const divider = document.createElement("span")
  const zoomValue = button("Reset view", "100%", resetView)
  const state = { zoom: 1, panX: 0, panY: 0, drag: true }

  overlay.setAttribute("data-component", "mermaid-viewer")
  overlay.dataset.panEnabled = "true"
  surface.setAttribute("data-slot", "mermaid-viewer-dialog")
  surface.setAttribute("role", "dialog")
  surface.setAttribute("aria-modal", "true")
  surface.setAttribute("aria-label", "Diagram viewer")

  viewport.setAttribute("data-slot", "mermaid-viewer-viewport")
  viewport.setAttribute(
    "aria-label",
    "Full-screen diagram. Drag to move, scroll or use plus and minus to zoom, use arrow keys to pan, and press 0 to reset.",
  )
  viewport.tabIndex = 0
  content.setAttribute("data-slot", "mermaid-viewer-content")
  content.setAttribute("aria-live", "polite")
  content.textContent = "Rendering diagram…"
  viewport.appendChild(content)

  toolbar.setAttribute("data-slot", "mermaid-viewer-toolbar")
  toolbar.setAttribute("role", "toolbar")
  toolbar.setAttribute("aria-label", "Diagram controls")
  divider.setAttribute("data-slot", "mermaid-viewer-divider")

  const closeButton = button("Close full screen", icons.close, close)
  const dragButton = button("Drag diagram", icons.drag, () => {
    state.drag = !state.drag
    overlay.dataset.panEnabled = String(state.drag)
    dragButton.setAttribute("aria-pressed", String(state.drag))
    if (state.drag) viewport.focus({ preventScroll: true })
  })
  const zoomOut = button("Zoom out", icons.minus, () => zoomAt(state.zoom - ZOOM_STEP, 0, 0))
  const zoomIn = button("Zoom in", icons.plus, () => zoomAt(state.zoom + ZOOM_STEP, 0, 0))
  closeButton.setAttribute("data-action", "close")
  dragButton.setAttribute("data-action", "drag")
  dragButton.setAttribute("aria-pressed", "true")
  zoomValue.setAttribute("data-action", "reset")
  zoomOut.setAttribute("data-action", "zoom-out")
  zoomIn.setAttribute("data-action", "zoom-in")
  toolbar.append(dragButton, divider, zoomOut, zoomValue, zoomIn)
  surface.append(viewport, closeButton, toolbar)
  overlay.appendChild(surface)
  document.body.appendChild(overlay)
  document.body.style.overflow = "hidden"

  let closed = false
  let pointerID: number | undefined
  let lastX = 0
  let lastY = 0

  function applyTransform() {
    content.style.transform =
      `translate(-50%, -50%) translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`
    zoomValue.textContent = `${Math.round(state.zoom * 100)}%`
  }

  function zoomAt(value: number, centerX: number, centerY: number) {
    const zoom = Math.max(0.25, Math.min(value, 4))
    const ratio = zoom / state.zoom
    state.panX = centerX - (centerX - state.panX) * ratio
    state.panY = centerY - (centerY - state.panY) * ratio
    state.zoom = zoom
    applyTransform()
  }

  function resetView() {
    state.zoom = 1
    state.panX = 0
    state.panY = 0
    applyTransform()
  }

  function close() {
    if (closed) return
    closed = true
    overlay.remove()
    document.body.style.overflow = previousOverflow
    if (closeActiveViewer === close) closeActiveViewer = undefined
    previousFocus?.focus({ preventScroll: true })
  }

  function onWheel(event: WheelEvent) {
    event.preventDefault()
    const bounds = viewport.getBoundingClientRect()
    zoomAt(
      state.zoom * (event.deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR),
      event.clientX - bounds.left - bounds.width / 2,
      event.clientY - bounds.top - bounds.height / 2,
    )
  }

  function onPointerDown(event: PointerEvent) {
    if (!state.drag || event.button !== 0) return
    event.preventDefault()
    pointerID = event.pointerId
    lastX = event.clientX
    lastY = event.clientY
    viewport.setPointerCapture(event.pointerId)
    overlay.dataset.dragging = "true"
  }

  function onPointerMove(event: PointerEvent) {
    if (pointerID !== event.pointerId) return
    state.panX += event.clientX - lastX
    state.panY += event.clientY - lastY
    lastX = event.clientX
    lastY = event.clientY
    applyTransform()
  }

  function onPointerUp(event: PointerEvent) {
    if (pointerID !== event.pointerId) return
    pointerID = undefined
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId)
    delete overlay.dataset.dragging
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault()
      close()
      return
    }
    if (event.key === "+" || event.key === "=") zoomAt(state.zoom + ZOOM_STEP, 0, 0)
    else if (event.key === "-" || event.key === "_") zoomAt(state.zoom - ZOOM_STEP, 0, 0)
    else if (event.key === "0") resetView()
    else if (event.key === "ArrowUp") state.panY += 32
    else if (event.key === "ArrowDown") state.panY -= 32
    else if (event.key === "ArrowLeft") state.panX += 32
    else if (event.key === "ArrowRight") state.panX -= 32
    else if (event.key === "Tab") {
      const focusable: HTMLElement[] = [viewport, dragButton, zoomOut, zoomValue, zoomIn, closeButton]
      const index = focusable.indexOf(document.activeElement as HTMLElement)
      const next = event.shiftKey ? (index - 1 + focusable.length) % focusable.length : (index + 1) % focusable.length
      event.preventDefault()
      focusable[next]?.focus({ preventScroll: true })
      return
    } else return
    event.preventDefault()
    applyTransform()
  }

  overlay.addEventListener("keydown", onKeyDown)
  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay) close()
  })
  viewport.addEventListener("wheel", onWheel, { passive: false })
  viewport.addEventListener("pointerdown", onPointerDown)
  viewport.addEventListener("pointermove", onPointerMove)
  viewport.addEventListener("pointerup", onPointerUp)
  viewport.addEventListener("pointercancel", onPointerUp)
  closeActiveViewer = close
  applyTransform()
  viewport.focus({ preventScroll: true })

  void renderDiagram(source)
    .then((svg) => {
      if (closed) return
      const safe = sanitize(svg)
      if (!safe) throw new Error("Mermaid SVG failed sanitization")
      content.innerHTML = safe
      const diagram = content.querySelector<SVGSVGElement>("svg")
      if (!diagram) throw new Error("Mermaid output did not contain an SVG")
      const viewBox = diagram.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number)
      const width = viewBox?.[2]
      const height = viewBox?.[3]
      if (width && height && Number.isFinite(width) && Number.isFinite(height)) {
        const fit = Math.min(
          1,
          viewport.clientWidth > 64 ? (viewport.clientWidth - 64) / width : 1,
          viewport.clientHeight > 96 ? (viewport.clientHeight - 96) / height : 1,
        )
        content.style.width = `${width * fit}px`
        content.style.height = `${height * fit}px`
        diagram.style.width = "100%"
        diagram.style.height = "100%"
      } else {
        diagram.style.width = "min(70vw, 1200px)"
        diagram.style.height = "auto"
      }
      diagram.style.maxWidth = "none"
      content.removeAttribute("aria-live")
      content.dataset.state = "ready"
    })
    .catch(() => {
      if (closed) return
      content.textContent = "This diagram could not be rendered."
      content.dataset.state = "error"
    })

  return close
}
