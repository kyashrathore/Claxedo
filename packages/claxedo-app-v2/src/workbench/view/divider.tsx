import type { JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { dictionary } from "../i18n"
import { useWorkbench } from "../provider"
import type { SplitNode } from "../types"

const KEYBOARD_STEP = 0.02

function keyboardDelta(horizontal: boolean, key: string): number {
  if (horizontal && key === "ArrowLeft") return -KEYBOARD_STEP
  if (horizontal && key === "ArrowRight") return KEYBOARD_STEP
  if (!horizontal && key === "ArrowUp") return -KEYBOARD_STEP
  if (!horizontal && key === "ArrowDown") return KEYBOARD_STEP
  if (key === "Home") return -1
  if (key === "End") return 1
  return 0
}

export function Divider(props: { split: Extract<SplitNode, { t: "split" }>; root: () => HTMLElement | undefined }): JSX.Element {
  const wb = useWorkbench()
  const t = useTranslator(dictionary)
  const horizontal = () => props.split.dir === "h"

  const onPointerDown = (event: PointerEvent) => {
    const rect = props.root()?.getBoundingClientRect()
    if (!rect) return
    const onMove = (move: PointerEvent) => {
      const ratio = horizontal() ? (move.clientX - rect.left) / rect.width : (move.clientY - rect.top) / rect.height
      wb.split.resize([], Math.min(1, Math.max(0, ratio)))
    }
    const onUp = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    event.preventDefault()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    const delta = keyboardDelta(horizontal(), event.key)
    if (delta === 0) return
    event.preventDefault()
    wb.split.resize([], Math.min(1, Math.max(0, props.split.size + delta)))
  }

  return (
    <div
      data-testid="workbench-divider"
      role="separator"
      tabindex="0"
      aria-label={t("workbench.resize")}
      aria-orientation={horizontal() ? "vertical" : "horizontal"}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(props.split.size * 100)}
      class="workbench-divider"
      data-direction={props.split.dir}
      style={horizontal() ? { left: `calc(${props.split.size * 100}% - 2px)` } : { top: `calc(${props.split.size * 100}% - 2px)` }}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    >
      <div aria-hidden="true" class="workbench-divider-line" />
    </div>
  )
}
