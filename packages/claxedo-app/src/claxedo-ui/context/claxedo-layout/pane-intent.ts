import type { PaneContent, PaneLayout } from "./types"

function slug(value: string) {
  const next = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return next
}

function baseName(content: PaneContent) {
  if (content.type === "session") return "session"
  if (content.type === "terminal") return "terminal"
  if (content.type === "review") return "review"
  if (content.type === "review-workspace") return "review-workspace"
  if (content.type === "context") return "context"
  if (content.type === "file") return "file"
  if (content.type === "page") return "page"
  return content.type
}

function normalize(value: string) {
  return value.trim().toLowerCase()
}

function formatMeta(meta: Record<string, string>) {
  const parts = Object.entries(meta)
    .filter((entry) => entry[1].trim())
    .map((entry) => `${entry[0]}=${JSON.stringify(entry[1])}`)
  if (!parts.length) return ""
  return ` [${parts.join(", ")}]`
}

export function paneIntentName(content: PaneContent, leafId?: string) {
  const explicit = content.intent?.name ? slug(content.intent.name) : ""
  if (explicit) return explicit
  const titled = content.title ? slug(content.title) : ""
  if (titled) return titled
  const base = baseName(content)
  if (!leafId) return base
  const suffix = leafId.split("-").at(-1)?.slice(0, 4)
  if (!suffix) return base
  return `${base}-${suffix}`
}

export function withPaneIntentName(content: PaneContent, leafId?: string): PaneContent {
  const name = paneIntentName(content, leafId)
  if (content.intent?.name === name) return content
  return {
    ...content,
    intent: {
      ...content.intent,
      name,
    },
  }
}

export type PaneInfo = {
  leafId: string
  name: string
  content: PaneContent
  meta: Record<string, string>
}

export function panes(layout: PaneLayout | undefined): PaneInfo[] {
  if (!layout) return []
  return Object.entries(layout.contents).map((entry) => {
    const leafId = entry[0]
    const content = withPaneIntentName(entry[1], leafId)
    return {
      leafId,
      name: content.intent?.name ?? paneIntentName(content, leafId),
      content,
      meta: content.intent?.meta ?? {},
    }
  })
}

export function paneForLeaf(layout: PaneLayout | undefined, leafId: string | undefined): PaneInfo | undefined {
  if (!layout || !leafId) return
  return panes(layout).find((pane) => pane.leafId === leafId)
}

export function paneDefaults(layout: PaneLayout | undefined, leafId: string | undefined) {
  return paneForLeaf(layout, leafId)?.content.intent?.defaults
}

export function paneRefSystem(layout: PaneLayout | undefined, leafId: string | undefined) {
  const source = paneForLeaf(layout, leafId)
  if (!source) return
  const base = source.content.intent?.defaults?.system?.trim()
  const refs = source.content.intent?.refs?.map(normalize).filter((name: string) => !!name) ?? []
  if (!refs.length) return base || undefined

  const all = panes(layout)
  const refPanes = refs
    .map((name: string) => all.find((pane: PaneInfo) => normalize(pane.name) === name))
    .filter((pane: PaneInfo | undefined): pane is PaneInfo => !!pane)
  if (!refPanes.length) return base || undefined

  const block = [
    "Pane refs:",
    ...refPanes.map((pane) => `- #${pane.name} (${pane.content.type})${formatMeta(pane.meta)}`),
    "When the user mentions a pane by #name, use that pane metadata.",
  ].join("\n")
  if (!base) return block
  return `${base}\n\n${block}`
}

export function parsePaneMentions(text: string) {
  const out: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(/#([a-zA-Z0-9][a-zA-Z0-9_-]*)/g)) {
    const value = normalize(match[1])
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

export function paneMentionSystem(layout: PaneLayout | undefined, text: string) {
  const mentions = parsePaneMentions(text)
  if (!mentions.length) return
  const all = panes(layout)
  const targets = mentions
    .map((name: string) => all.find((pane: PaneInfo) => normalize(pane.name) === name))
    .filter((pane: PaneInfo | undefined): pane is PaneInfo => !!pane)
  if (!targets.length) return
  return [
    "Pane mentions in this message:",
    ...targets.map((pane) => `- #${pane.name} (${pane.content.type})${formatMeta(pane.meta)}`),
  ].join("\n")
}
