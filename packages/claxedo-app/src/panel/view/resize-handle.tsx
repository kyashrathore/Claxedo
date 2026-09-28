import { onCleanup, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { emitTerminalFit } from "@/lib/terminal-fit"
import { panelDictionary } from "../i18n"
import { usePanel } from "../store"
import { maxPanelWidth, NAVIGATOR_MIN_WIDTH, PANEL_MIN_WIDTH, PANEL_RESIZE_KEY_STEP } from "../width"

type Growth = "left" | "right"

type Drag = {
  readonly grows: Growth
  readonly pointerId: number
  readonly startX: number
  readonly startWidth: number
  readonly handle: HTMLElement
}

function growthSign(grows: Growth): number {
  return grows === "right" ? 1 : -1
}

type Range = { readonly value: number; readonly min: number; readonly max: number; readonly grows: Growth }

function keyboardWidth(key: string, range: Range): number | undefined {
  if (key === "ArrowRight") return range.value + growthSign(range.grows) * PANEL_RESIZE_KEY_STEP
  if (key === "ArrowLeft") return range.value - growthSign(range.grows) * PANEL_RESIZE_KEY_STEP
  if (key === "Home") return range.min
  if (key === "End") return range.max
  return undefined
}

function suspendPage(): () => void {
  const previousUserSelect = document.body.style.userSelect
  const previousCursor = document.body.style.cursor
  const previousSuspended = document.documentElement.dataset.terminalResizeSuspended
  document.body.style.userSelect = "none"
  document.body.style.cursor = "col-resize"
  document.documentElement.dataset.terminalResizeSuspended = "1"
  return () => {
    document.body.style.userSelect = previousUserSelect
    document.body.style.cursor = previousCursor
    if (previousSuspended === undefined) delete document.documentElement.dataset.terminalResizeSuspended
    else document.documentElement.dataset.terminalResizeSuspended = previousSuspended
  }
}

function trackDrag(drag: Drag, onWidth: (width: number) => void, onEnd: () => void): () => void {
  let frame: number | undefined
  let latestX = drag.startX
  const restorePage = suspendPage()
  const flush = () => {
    frame = undefined
    onWidth(drag.startWidth + growthSign(drag.grows) * (latestX - drag.startX))
  }
  const onMove = (event: PointerEvent) => {
    if (event.pointerId !== drag.pointerId) return
    latestX = event.clientX
    frame ??= requestAnimationFrame(flush)
  }
  const finish = () => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    restorePage()
    window.removeEventListener("pointermove", onMove)
    window.removeEventListener("pointerup", onUp)
    window.removeEventListener("pointercancel", onCancel)
    if (drag.handle.hasPointerCapture?.(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId)
    onEnd()
    emitTerminalFit()
  }
  const onUp = (event: PointerEvent) => {
    if (event.pointerId !== drag.pointerId) return
    latestX = event.clientX
    flush()
    finish()
  }
  const onCancel = (event: PointerEvent) => {
    if (event.pointerId === drag.pointerId) finish()
  }
  window.addEventListener("pointermove", onMove)
  window.addEventListener("pointerup", onUp)
  window.addEventListener("pointercancel", onCancel)
  return finish
}

type ResizeSeparatorProps = Range & {
  readonly label: string
  readonly class: string
  readonly onResize: (width: number) => void
  readonly onDragging: (dragging: boolean) => void
}

function ResizeSeparator(props: ResizeSeparatorProps): JSX.Element {
  let stop: (() => void) | undefined
  onCleanup(() => stop?.())
  const start = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    stop?.()
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    props.onDragging(true)
    const drag = {
      grows: props.grows,
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: props.value,
      handle: event.currentTarget,
    }
    stop = trackDrag(drag, props.onResize, () => {
      stop = undefined
      props.onDragging(false)
    })
  }
  const resizeByKeyboard = (event: KeyboardEvent) => {
    const next = keyboardWidth(event.key, props)
    if (next === undefined) return
    event.preventDefault()
    props.onResize(next)
    emitTerminalFit()
  }
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={props.label}
      aria-valuenow={Math.round(props.value)}
      aria-valuemin={props.min}
      aria-valuemax={Math.round(props.max)}
      class={`absolute bottom-0 top-0 z-10 cursor-col-resize outline-none transition-colors ${props.class}`}
      onPointerDown={start}
      onKeyDown={resizeByKeyboard}
    />
  )
}

export function PanelResizeHandle(props: { readonly onDragging: (dragging: boolean) => void }): JSX.Element {
  const t = useTranslator(panelDictionary)
  const panel = usePanel()
  return (
    <ResizeSeparator
      label={t("panel.resize")}
      value={panel.width()}
      min={PANEL_MIN_WIDTH}
      max={maxPanelWidth(panel.available())}
      grows="left"
      class="left-0 w-1 hover:bg-border-weak-base/25 focus-visible:bg-border-interactive-base/60 active:bg-border-weak-base/45"
      onResize={panel.chooseWidth}
      onDragging={props.onDragging}
    />
  )
}

export function NavigatorResizeHandle(props: {
  readonly side: Growth
  readonly onDragging: (dragging: boolean) => void
}): JSX.Element {
  const t = useTranslator(panelDictionary)
  const panel = usePanel()
  return (
    <ResizeSeparator
      label={t("panel.navigator.resize")}
      value={panel.navigatorWidth()}
      min={NAVIGATOR_MIN_WIDTH}
      max={panel.navigatorMaxWidth()}
      grows={props.side === "left" ? "right" : "left"}
      class="-left-1 w-2 after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:transition-colors hover:after:bg-border-base focus-visible:after:bg-border-interactive-base active:after:bg-border-base"
      onResize={panel.chooseNavigatorWidth}
      onDragging={props.onDragging}
    />
  )
}
