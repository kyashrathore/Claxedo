import { setMermaidRenderer } from "@/ui/session-kit"

/**
 * Timeline mermaid renderer (T14). Lazily loads mermaid on the first diagram, renders with
 * `securityLevel: "strict"` and the `base` theme (themeVariables probed from the app's CSS
 * vars so diagrams match light/dark), and hands the SVG back to the session-ui markdown
 * decorator via setMermaidRenderer. Registered once at app start.
 */
let mermaidModule: Promise<typeof import("mermaid")> | null = null
let counter = 0

function themeVariables(): Record<string, string> {
  if (typeof document === "undefined") return {}
  const probe = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string) => probe.getPropertyValue(name).trim() || fallback
  const text = read("--text-strong", "#e6e6e6")
  const line = read("--border-weak-base", "#444")
  const surface = read("--background-stronger", "#181818")
  return {
    background: surface,
    primaryColor: surface,
    primaryTextColor: text,
    primaryBorderColor: line,
    lineColor: line,
    secondaryColor: surface,
    tertiaryColor: surface,
    textColor: text,
    mainBkg: surface,
    nodeBorder: line,
  }
}

function getMermaid() {
  if (!mermaidModule) {
    mermaidModule = import("mermaid")
      .then((m) => {
        m.default.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          suppressErrorRendering: true,
          theme: "base",
          themeVariables: themeVariables(),
        })
        return m
      })
      .catch((error) => {
        mermaidModule = null
        throw error
      })
  }
  return mermaidModule
}

export async function renderTimelineMermaid(source: string): Promise<string> {
  const m = await getMermaid()
  const { svg } = await m.default.render(`mermaid-tl-${++counter}`, source)
  return svg
}

let installed = false
export function installTimelineMermaid() {
  if (installed) return
  installed = true
  setMermaidRenderer(renderTimelineMermaid)
}
