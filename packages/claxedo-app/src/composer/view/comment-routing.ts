import type { PanelFocus } from "@/panel"
import type { FileContextItem } from "../model"

export function commentFocus(item: FileContextItem): PanelFocus | undefined {
  if (!item.commentId) return undefined
  if (item.commentOrigin === "review") return { kind: "review", path: item.path }
  return { kind: "file", path: item.path, ...(item.selection ? { line: item.selection.startLine } : {}) }
}
