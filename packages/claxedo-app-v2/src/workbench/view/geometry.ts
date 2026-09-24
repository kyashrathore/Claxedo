import type { JSX } from "solid-js"
import type { PaneRect } from "../types"

export function rectStyle(rect: PaneRect | undefined): JSX.CSSProperties {
  if (!rect) return { display: "none" }
  return {
    left: `${rect.left * 100}%`,
    top: `${rect.top * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`,
  }
}

export function absoluteRect(rect: PaneRect, size: { w: number; h: number }): PaneRect {
  return { left: rect.left * size.w, top: rect.top * size.h, width: rect.width * size.w, height: rect.height * size.h }
}
