import { setMermaidViewer } from "@/transcript"
import { openMermaidViewer } from "./markdown-viewer"

let installed = false

export function installTimelineMermaid() {
  if (installed) return
  installed = true
  setMermaidViewer(openMermaidViewer)
}
