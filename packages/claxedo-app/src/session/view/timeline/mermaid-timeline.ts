import { sanitizeSvg, setMermaidRenderer, setMermaidViewer } from "@/transcript"
import { mermaidThemeVariables, renderMermaidSvg } from "@/transcript"
import { openMermaidViewer } from "./markdown-viewer"

let installed = false
export function installTimelineMermaid(
  nativeRenderer?: (source: string, theme?: Record<string, string>) => Promise<string>,
) {
  if (installed) return
  installed = true
  const renderer = nativeRenderer ? (source: string) => nativeRenderer(source, mermaidThemeVariables()) : renderMermaidSvg
  setMermaidRenderer(renderer)
  setMermaidViewer((source) => openMermaidViewer(source, renderer, sanitizeSvg))
}
