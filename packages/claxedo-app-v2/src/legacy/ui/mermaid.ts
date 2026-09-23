import { sanitizeSvg } from "./session-kit-loaders"

/**
 * Shared mermaid loader and renderer configuration for every surface that
 * renders assistant-authored diagrams (session timeline, documents editor).
 * One lazy `import("mermaid")`, one `initialize` call, one id counter — a
 * second configuration would drift from the strict-mode + htmlLabels-off
 * policy the sanitizer is tuned for.
 */
let mermaidModule: Promise<typeof import("mermaid")> | null = null
let counter = 0

export function mermaidThemeVariables(): Record<string, string> {
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
          // Defense in depth, paired with `sanitizeSvg` in session-ui. With HTML
          // labels on, mermaid wraps every flowchart/class/state label in a
          // `<foreignObject>` — an HTML document embedded in the SVG, and the
          // classic way payloads walk past an SVG sanitizer. Turning them off
          // makes mermaid emit native `<text>`/`<tspan>` instead, so the whole
          // HTML-in-SVG surface disappears at the source and the sanitizer can
          // drop `foreignObject` outright without costing a single label.
          // Verified across flowchart/sequence/class/state/er/gantt/pie/git/mindmap:
          // zero foreignObject and visually identical output.
          htmlLabels: false,
          flowchart: { htmlLabels: false },
          class: { htmlLabels: false },
          themeVariables: mermaidThemeVariables(),
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

/**
 * Renders the diagram source to raw (unsanitized) SVG. Callers that assign the
 * result to a DOM sink must run `sanitizeSvg` first — or use
 * `renderSafeMermaidSvg`, which does both.
 */
export async function renderMermaidSvg(source: string): Promise<string> {
  const m = await getMermaid()
  return (await m.default.render(`mermaid-${++counter}`, source)).svg
}

/**
 * Renders and sanitizes in one step. Throws when the sanitizer cannot vouch
 * for the markup — an unrenderable diagram beats an unsanitized one, so the
 * raw string must never reach the DOM as a fallback.
 */
export async function renderSafeMermaidSvg(source: string): Promise<string> {
  const safe = sanitizeSvg(await renderMermaidSvg(source))
  if (!safe) throw new Error("mermaid: SVG failed sanitization")
  return safe
}
