import { Show, createEffect, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import type { WorkspacePanelMode, WorkspacePanelState } from "./workspace-panel-state"

export const WORKSPACE_PANEL_TOGGLE_FULLWIDTH = "claxedo:workspace-panel-toggle-fullwidth"

const [fullWidthSignal, setFullWidthSignal] = createSignal(false)
export const workspacePanelFullWidth = fullWidthSignal

export type WorkspacePanelProps = {
  state: WorkspacePanelState
  onModeSelect?: (mode: WorkspacePanelMode) => void
  onClose?: () => void
  renderMode: (mode: WorkspacePanelMode, state: WorkspacePanelState) => JSX.Element
}

export function WorkspacePanel(props: WorkspacePanelProps) {
  const minWidth = 360
  const navigatorWidth = () => props.state.navigator === "files" ? 240 : props.state.navigator === "processes" ? 280 : 0
  const open = () => props.state.open && !!props.state.mode
  const maxWidth = () => Math.max(minWidth + navigatorWidth(), Math.min(1120, Math.floor(window.innerWidth * 0.86)))
  const [width, setWidth] = createSignal(520)
  const [dragging, setDragging] = createSignal(false)
  const [restoreWidth, setRestoreWidth] = createSignal<number | null>(null)
  const [parentWidth, setParentWidth] = createSignal(0)
  let asideRef: HTMLElement | undefined
  const panelWidth = () => {
    if (!open()) return 0
    if (fullWidthSignal()) return parentWidth()
    return Math.min(width() + navigatorWidth(), maxWidth())
  }

  const clampWidth = (w: number) => Math.max(minWidth, Math.min(maxWidth() - navigatorWidth(), w))

  const toggleFullWidth = () => {
    if (fullWidthSignal()) {
      setFullWidthSignal(false)
      const prev = restoreWidth()
      if (prev != null) setWidth(clampWidth(prev))
      setRestoreWidth(null)
    } else {
      setRestoreWidth(width())
      setFullWidthSignal(true)
    }
    window.dispatchEvent(new Event("opencode:terminal-fit"))
  }
  createEffect(() => {
    if (!open() && fullWidthSignal()) {
      setFullWidthSignal(false)
      setRestoreWidth(null)
    }
  })
  onMount(() => {
    const handler = () => toggleFullWidth()
    window.addEventListener(WORKSPACE_PANEL_TOGGLE_FULLWIDTH, handler)
    onCleanup(() => window.removeEventListener(WORKSPACE_PANEL_TOGGLE_FULLWIDTH, handler))
    const parent = asideRef?.parentElement
    if (parent) {
      const update = () => setParentWidth(parent.clientWidth)
      update()
      const ro = new ResizeObserver(update)
      ro.observe(parent)
      onCleanup(() => ro.disconnect())
    }
  })

  const resize = (event: PointerEvent) => {
    event.preventDefault()
    const handle = event.currentTarget as HTMLElement
    const startX = event.clientX
    const startWidth = width()
    handle.setPointerCapture?.(event.pointerId)
    document.body.style.userSelect = "none"
    document.body.style.cursor = "col-resize"
    // Suppresses terminal re-layout / xterm fit while dragging.
    document.documentElement.dataset.terminalResizeSuspended = "1"
    setDragging(true)

    let pending = false
    let latestX = event.clientX
    const flush = () => {
      pending = false
      setWidth(clampWidth(startWidth + startX - latestX))
    }

    const onMove = (move: PointerEvent) => {
      latestX = move.clientX
      if (pending) return
      pending = true
      requestAnimationFrame(flush)
    }

    const onUp = (up: PointerEvent) => {
      latestX = up.clientX
      flush()
      setDragging(false)
      document.body.style.userSelect = ""
      document.body.style.cursor = ""
      delete document.documentElement.dataset.terminalResizeSuspended
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      handle.releasePointerCapture?.(event.pointerId)
      window.dispatchEvent(new Event("opencode:terminal-fit"))
    }

    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
  }

  return (
    <aside
      ref={(el) => (asideRef = el)}
      aria-label={open() ? "Workspace panel" : undefined}
      aria-hidden={open() ? undefined : "true"}
      role={open() ? "complementary" : undefined}
      class="relative flex h-full shrink-0 flex-col overflow-hidden bg-background-base will-change-[width,transform]"
      classList={{
        "translate-x-0 opacity-100": open(),
        "translate-x-full opacity-0 pointer-events-none": !open(),
        // Transition is only active when NOT dragging. During drag, width changes are
        // applied instantly so updates don't queue up behind a 200ms animation.
        "transition-[width,transform,opacity] duration-200 ease-out": !dragging(),
      }}
      style={{
        width: panelWidth() + "px",
        "border-left": "1px solid var(--border-weaker-base)",
      }}
    >
      <Show when={open() && props.state.mode}>
        {(mode) => (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize workspace panel"
              class="absolute bottom-0 left-0 top-0 z-10 w-1 cursor-col-resize transition-colors hover:bg-border-strong-base/40 active:bg-border-strong-base/60"
              onPointerDown={resize}
            />
            <div class="min-h-0 flex-1 overflow-auto">
              {props.renderMode(mode(), props.state)}
            </div>
          </>
        )}
      </Show>
    </aside>
  )
}
