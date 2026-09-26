import { nextIdleSlice } from "@/lib/idle"
import { sanitizeSvg } from "./markdown-cache"

let mermaidModule: Promise<typeof import("mermaid")> | null = null
let counter = 0

const SRGB = /^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.e-]+))?\)$/

function resolveColor(name: string, fallback: string): string {
  const probe = document.createElement("span")
  probe.style.display = "none"
  probe.style.color = `var(${name}, ${fallback})`
  document.body.appendChild(probe)
  const computed = getComputedStyle(probe).color
  probe.remove()
  const srgb = SRGB.exec(computed)
  if (!srgb) return computed || fallback
  const [r, g, b] = srgb.slice(1, 4).map((channel) => Math.round(Number(channel) * 255))
  return `rgba(${r}, ${g}, ${b}, ${srgb[4] ?? 1})`
}

export function mermaidThemeVariables(): Record<string, string> {
  if (typeof document === "undefined" || !document.body) return {}
  const text = resolveColor("--text-strong", "#e6e6e6")
  const line = resolveColor("--border-weak-base", "#444")
  const surface = resolveColor("--background-stronger", "#181818")
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

export async function renderMermaidSvg(source: string): Promise<string> {
  await nextIdleSlice()
  const m = await getMermaid()
  await nextIdleSlice()
  await m.default.parse(source)
  await nextIdleSlice()
  return (await m.default.render(`mermaid-${++counter}`, source)).svg
}

export async function renderSafeMermaidSvg(source: string): Promise<string> {
  const safe = sanitizeSvg(await renderMermaidSvg(source))
  if (!safe) throw new Error("mermaid: SVG failed sanitization")
  return safe
}
