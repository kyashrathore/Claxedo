import {
  transcriptLinkPrefixes,
  transcriptLinkRunSource,
  transcriptLinkUriAllowed,
} from "@opencode-ai/ui/context/marked"

export { transcriptLinkUriPattern } from "@opencode-ai/ui/context/marked"

const prefixAlternation = transcriptLinkPrefixes.map((prefix) => prefix.replace(/[./]/g, "\\$&")).join("|")

/** Not `transcriptLinkRunSource`: an exact match ends at a paren, a run inside prose may open one. */
const linkText = new RegExp(`^(?:${prefixAlternation})[^\\s<>()\`"']+$`, "i")

const linkInText = new RegExp(transcriptLinkRunSource(transcriptLinkPrefixes), "gi")

const trailingPunctuation = /[),.;:!?]+$/

/**
 * The href for a value that is meant to BE a link — a markdown code span, an
 * already-extracted match. Returns undefined for prose that merely contains
 * one, so `curl https://example.com` stays a command.
 */
export function transcriptLinkHref(text: string | undefined): string | undefined {
  if (!text) return undefined
  const candidate = text.trim().replace(trailingPunctuation, "")
  if (!linkText.test(candidate)) return undefined
  try {
    return new URL(candidate).toString()
  } catch {
    return undefined
  }
}

/** Distinct links embedded in prose or tool output, in the order they appear. */
export function transcriptLinks(text: string | undefined): string[] {
  if (!text) return []
  const seen = new Set<string>()
  for (const match of text.matchAll(linkInText)) {
    const href = transcriptLinkHref(match[0])
    if (href) seen.add(href)
  }
  return [...seen]
}

/**
 * Hands the link to whatever surface is hosting the transcript. A host claims
 * it by cancelling the event; an uncancelled event leaves the anchor's own
 * `target="_blank"` default in place, which is what the storybook lab and a
 * plain web build rely on.
 */
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
  // A target the sanitizer would refuse never reaches default navigation —
  // whatever button or modifiers carried the click. Returning early here is
  // what makes a rejected `javascript:`/`data:` bind a no-op instead of an
  // anchor the browser still resolves on its own.
  if (!transcriptLinkUriAllowed(raw)) {
    event.preventDefault()
    return
  }
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  const href = transcriptLinkHref(raw)
  if (!href) return
  if (dispatchTranscriptLinkOpen(anchor, href)) event.preventDefault()
}
