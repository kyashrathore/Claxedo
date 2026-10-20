import { ClaxedoTool } from "./claxedo-tool"
import type { ToolComponent } from "./message-part"
import { SurfaceReply } from "./surface-reply"

export function claxedoToolRow(name: string | undefined): ToolComponent | undefined {
  if (name === undefined) return undefined
  return name === "ui_show" ? SurfaceReply : ClaxedoTool
}
