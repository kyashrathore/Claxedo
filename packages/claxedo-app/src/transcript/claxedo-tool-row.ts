import { lazy } from "solid-js"
import { loadChunk } from "@/lib/lazy-view"
import { ClaxedoTool } from "./claxedo-tool"
import type { ToolComponent } from "./message-part"

export const loadSurfaceReply = () => import("./surface-reply")

const SurfaceReply = lazy<ToolComponent>(() => loadChunk(loadSurfaceReply).then((module) => ({ default: module.SurfaceReply })))

export function claxedoToolRow(name: string | undefined): ToolComponent | undefined {
  if (name === undefined) return undefined
  return name === "ui_show" ? SurfaceReply : ClaxedoTool
}
