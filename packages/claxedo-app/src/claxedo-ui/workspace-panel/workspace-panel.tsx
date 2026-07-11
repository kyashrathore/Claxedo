import { Show, createEffect, createMemo, createRoot, createSignal, getOwner, onCleanup, onMount, runWithOwner, untrack, type JSX } from "solid-js"
import { emitTerminalFit } from "../terminal/terminal-fit"
import type { WorkspacePanelMode, WorkspacePanelState } from "./workspace-panel-state"

const SHELL_MOTION_MS = 120
const SHELL_MOTION_TRANSITION = `transform ${SHELL_MOTION_MS}ms cubic-bezier(0.2, 0, 0, 1)`

export type WorkspacePanelProps = {
  state: WorkspacePanelState
  visualOpen?: () => boolean
  onShellRef?: (element: HTMLElement | undefined) => void
  onRestingWidthChange?: (width: number) => void
  fullWidth?: () => boolean
  onModeSelect?: (mode: WorkspacePanelMode) => void
  onClose?: () => void
  renderMode: (mode: WorkspacePanelMode, state: WorkspacePanelState) => JSX.Element
  contentIdentity?: (state: WorkspacePanelState) => unknown
  // Optional chrome that renders at the top of the panel
  // column (above the body). Used to scope the L2 toolbar trio
  // (Files / Processes / Workspace Review + per-tab context) to the
  // panel column only, instead of spanning the full workbench width.
  renderHeader?: (state: WorkspacePanelState) => JSX.Element
}

export function WorkspacePanel(props: WorkspacePanelProps) {
  const minWidth = 360
  const minReadableContentWidth = 300
  const [viewportWidth, setViewportWidth] = createSignal(typeof window === "undefined" ? 1024 : window.innerWidth)
  const stateOpen = () => props.state.open && !!props.state.mode
  const open = () => props.visualOpen?.() ?? stateOpen()
  const isMobile = () => viewportWidth() < 640
  const availableWidth = () => parentWidth() || viewportWidth()
  const readablePanelLimit = () => Math.max(minWidth, availableWidth() - Math.min(minReadableContentWidth, Math.max(0, availableWidth() - minWidth)))
  const defaultWidth = () => Math.min(Math.max(minWidth, Math.floor(availableWidth() * 0.7)), readablePanelLimit())
  const maxWidth = () => Math.min(Math.max(minWidth, Math.floor(availableWidth() * 0.86)), readablePanelLimit())
  const [width, setWidth] = createSignal<number | undefined>()
  const [dragging, setDragging] = createSignal(false)
  const [panelExposed, setPanelExposed] = createSignal(open())
  const [parentWidth, setParentWidth] = createSignal(0)
  const contentKey = createMemo(() =>
    JSON.stringify(props.contentIdentity?.(props.state) ?? {
      activitySubject: props.state.activitySubject,
      mode: props.state.mode,
      targetPaneId: props.state.targetPaneId,
      workspaceDir: props.state.workspaceDir,
    }))
  const [renderedMode, setRenderedMode] = createSignal<JSX.Element>()
  const owner = getOwner()
  let renderedKey = ""
  let disposeRenderedMode: VoidFunction | undefined
  createEffect(() => {
    const nextKey = contentKey()
    if (nextKey === renderedKey && (renderedMode() !== undefined || !props.state.mode)) return
    renderedKey = nextKey
    const hadRenderedMode = renderedMode() !== undefined
    disposeRenderedMode?.()
    disposeRenderedMode = undefined
    const mode = props.state.mode
    if (!mode) {
      setRenderedMode(undefined)
      return
    }
    setRenderedMode(undefined)
    const renderBody = () => {
      runWithOwner(owner, () => {
        createRoot((dispose) => {
          disposeRenderedMode = dispose
          setRenderedMode(() => untrack(() => props.renderMode(mode, props.state)))
        })
      })
    }
    if (hadRenderedMode && stateOpen()) {
      renderBody()
      return
    }
    renderBody()
  })
  onCleanup(() => {
    disposeRenderedMode?.()
  })
  let exposeTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    if (exposeTimer) {
      clearTimeout(exposeTimer)
      exposeTimer = undefined
    }
    if (open()) {
      setPanelExposed(true)
      return
    }
    exposeTimer = setTimeout(() => {
      setPanelExposed(false)
      exposeTimer = undefined
    }, SHELL_MOTION_MS + 20)
  })
  onCleanup(() => {
    if (exposeTimer) clearTimeout(exposeTimer)
  })
  let asideRef: HTMLElement | undefined
  const restingPanelWidth = () => {
    if (isMobile()) return availableWidth()
    if (props.fullWidth?.()) return availableWidth()
    return Math.min(width() ?? defaultWidth(), maxWidth())
  }
  const panelStyleWidth = () => isMobile() ? "100%" : `${restingPanelWidth()}px`
  const pendingMode = () => {
    if (props.state.navigator !== "files" && props.state.navigator !== "changes") return undefined
    const mode = props.state.navigator === "changes" ? "changes" : "files"
    return (
      <div
        data-testid="workspace-files-navigator"
        data-mode={mode}
        data-file-tree-shell-ready="true"
        class="flex size-full min-h-0 flex-col"
      >
        <div class="shrink-0 flex items-center gap-1 px-2 h-9 border-b border-border-weak-base">
          <div class="h-4 w-4 rounded bg-surface-base" />
          <div class="h-5 min-w-0 flex-1 rounded bg-surface-base" />
        </div>
        <div class="min-h-0 flex-1 overflow-hidden">
          <div data-component="filetree" class="flex flex-col gap-0.5 p-1">
            <div data-file-tree-loading class="flex flex-col gap-0.5" aria-label="Loading files">
              <div class="h-6 w-[82%] rounded-md bg-surface-base" />
              <div class="h-6 w-[76%] rounded-md bg-surface-base" />
              <div class="h-6 w-[69%] rounded-md bg-surface-base" />
              <div class="h-6 w-[61%] rounded-md bg-surface-base" />
              <div class="h-6 w-[54%] rounded-md bg-surface-base" />
            </div>
          </div>
        </div>
      </div>
    )
  }

  createEffect(() => {
    props.onRestingWidthChange?.(restingPanelWidth())
  })

  const clampWidth = (w: number) => Math.max(minWidth, Math.min(maxWidth(), w))

  // Keyboard resize for the ARIA window-splitter separator. The panel is
  // anchored right, so ArrowLeft widens it (mirrors dragging the left handle
  // leftward) and ArrowRight narrows it; Home/End jump to the min/max width.
  const RESIZE_KEY_STEP = 24
  const resizeByKeyboard = (event: KeyboardEvent) => {
    const current = restingPanelWidth()
    let next: number
    switch (event.key) {
      case "ArrowLeft":
        next = current + RESIZE_KEY_STEP
        break
      case "ArrowRight":
        next = current - RESIZE_KEY_STEP
        break
      case "Home":
        next = minWidth
        break
      case "End":
        next = maxWidth()
        break
      default:
        return
    }
    event.preventDefault()
    setWidth(clampWidth(next))
    emitTerminalFit()
  }

  onMount(() => {
    const updateViewportWidth = () => setViewportWidth(window.innerWidth)
    window.addEventListener("resize", updateViewportWidth)
    onCleanup(() => window.removeEventListener("resize", updateViewportWidth))
    const parent = asideRef?.parentElement
    if (parent) {
      const update = () => setParentWidth(parent.clientWidth)
      update()
      if (typeof ResizeObserver !== "undefined") {
        const ro = new ResizeObserver(update)
        ro.observe(parent)
        onCleanup(() => ro.disconnect())
      }
    }
  })
  onCleanup(() => {
    props.onShellRef?.(undefined)
  })

  const resize = (event: PointerEvent) => {
    event.preventDefault()
    const handle = event.currentTarget as HTMLElement
    const startX = event.clientX
    const startWidth = width() ?? defaultWidth()
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
      emitTerminalFit()
    }

    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
  }

  return (
    <aside
      ref={(el) => {
        asideRef = el
        props.onShellRef?.(el)
      }}
      aria-label={panelExposed() ? "Workspace panel" : undefined}
      aria-hidden={panelExposed() ? undefined : "true"}
      role={panelExposed() ? "complementary" : undefined}
      data-testid="workspace-panel-shell"
      data-open={open() ? "true" : "false"}
      data-state-open={props.state.open ? "true" : "false"}
      data-state-mode={props.state.mode ?? ""}
      data-state-workspace-dir={props.state.workspaceDir ?? ""}
      class="absolute bottom-0 right-0 top-0 z-30 flex flex-col overflow-hidden bg-background-base will-change-[transform,opacity]"
      classList={{
        "pointer-events-none": !open(),
      }}
      style={{
        width: panelStyleWidth(),
        "border-left": "1px solid var(--border-weaker-base)",
        contain: "strict",
        "backface-visibility": "hidden",
        transform: open() ? "translate3d(0, 0, 0)" : "translate3d(100%, 0, 0)",
        transition: dragging() ? "none" : SHELL_MOTION_TRANSITION,
        display: panelExposed() ? undefined : "none",
        visibility: panelExposed() ? "visible" : "hidden",
        "--workspace-panel-width": restingPanelWidth() + "px",
      }}
    >
      <Show when={open() && props.state.mode && !isMobile()}>
        <div
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label="Resize workspace panel"
          aria-valuenow={Math.round(restingPanelWidth())}
          aria-valuemin={minWidth}
          aria-valuemax={Math.round(maxWidth())}
          class="absolute bottom-0 left-0 top-0 z-10 w-1 cursor-col-resize outline-none transition-colors hover:bg-border-weak-base/25 focus-visible:bg-border-interactive-base/60 active:bg-border-weak-base/45"
          onPointerDown={resize}
          onKeyDown={resizeByKeyboard}
        />
      </Show>
      <div
        class="shrink-0"
      >
        {props.renderHeader?.(props.state)}
      </div>
      <div
        class="min-h-0 flex-1 overflow-auto"
      >
        {renderedMode() ?? pendingMode()}
      </div>
    </aside>
  )
}
