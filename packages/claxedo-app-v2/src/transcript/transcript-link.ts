import { transcriptLinkPrefixes, transcriptLinkRunSource, transcriptLinkUriAllowed } from "@/ui"

export { transcriptLinkUriPattern } from "@/ui"

const prefixAlternation = transcriptLinkPrefixes.map((prefix) => prefix.replace(/[./]/g, "\\$&")).join("|")

const linkText = new RegExp(`^(?:${prefixAlternation})[^\\s<>()\`"']+$`, "i")

const linkInText = new RegExp(transcriptLinkRunSource(transcriptLinkPrefixes), "gi")

const trailingPunctuation = /[),.;:!?]+$/

export function transcriptLinkHref(text: string | undefined): string | undefined {
  if (!text) return undefined
  const candidate = text.trim().replace(trailingPunctuation, "")
  if (!linkText.test(candidate)) return undefined
  return URL.canParse(candidate) ? new URL(candidate).toString() : undefined
}

export function transcriptLinks(text: string | undefined): string[] {
  if (!text) return []
  const seen = new Set<string>()
  for (const match of text.matchAll(linkInText)) {
    const href = transcriptLinkHref(match[0])
    if (href) seen.add(href)
  }
  return [...seen]
}

export function dispatchTranscriptLinkOpen(target: EventTarget | null, href: string): boolean {
  if (!target) return false
  return !target.dispatchEvent(
    new CustomEvent("claxedo:open-link", { bubbles: true, cancelable: true, detail: { href } }),
  )
}

export function handleTranscriptLinkClick(event: MouseEvent) {
  if (event.defaultPrevented) return
  const target = event.target instanceof Element ? event.target : undefined
  const anchor = target?.closest("a[href]")
  if (!anchor) return
  const raw = anchor.getAttribute("href") ?? ""
  if (!transcriptLinkUriAllowed(raw)) {
    event.preventDefault()
    return
  }
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  const href = transcriptLinkHref(raw)
  if (!href) return
  if (dispatchTranscriptLinkOpen(anchor, href)) event.preventDefault()
}
