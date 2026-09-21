import { sanitizeSvg, setMermaidRenderer, setMermaidViewer } from "@/ui/session-kit"
import { mermaidThemeVariables, renderMermaidSvg } from "@/ui/mermaid"
import { createMermaidBackend } from "./mermaid-backend"
import { openMermaidViewer } from "./markdown-viewer"

/**
 * Hands the shared `@/ui/mermaid` renderer (strict mode, `base` theme probed
 * from the app's CSS vars so diagrams follow light/dark) to the session-ui
 * markdown decorator via setMermaidRenderer. Registered once at app start.
 * The decorator re-sanitizes whatever this returns through `sanitizeSvg`
 * before it reaches `innerHTML`.
 */
let installed = false
export function installTimelineMermaid(
  nativeRenderer?: (source: string, theme?: Record<string, string>) => Promise<string>,
) {
  if (installed) return
  installed = true
  const renderer = createMermaidBackend({ nativeRenderer, fallback: renderMermaidSvg, theme: mermaidThemeVariables })
  setMermaidRenderer(renderer)
  setMermaidViewer((source) => openMermaidViewer(source, renderer, sanitizeSvg))
}
