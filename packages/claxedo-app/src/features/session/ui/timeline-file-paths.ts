// Path handling for timeline file interactions: `@path` chips in assistant
// markdown (click-to-open, T16) and the file context menu (T11).

import {
  resolveWorkspaceFileFocus,
  type WorkspaceFileFocusTarget,
} from "@/platform/files/workspace-file-focus"

// Path chips render opencode mentions as `@path`; strip the mention sigil
// before resolving. (A path literally starting with `@` — e.g. an npm scope
// directory — is indistinguishable from a mention here; mentions win.)
export const stripMentionSigil = (raw: string) => raw.trim().replace(/^@/, "")

/**
 * Shared with the terminal's file links: normalizes `./`, relativizes
 * absolute-in-workspace paths, parses `:line[:col]` suffixes, and refuses
 * `~`/traversal/out-of-workspace paths (which used to open blank tabs).
 */
export function timelineFileFocus(
  raw: string,
  workspaceDir: string,
): WorkspaceFileFocusTarget | undefined {
  return resolveWorkspaceFileFocus(stripMentionSigil(raw), workspaceDir)
}

/** Absolute form for the OS-level desktop actions (Copy path / Reveal). */
export function resolveTimelinePath(raw: string, workspaceDir: string): string {
  const target = timelineFileFocus(raw, workspaceDir)
  if (!target) return stripMentionSigil(raw)
  return `${workspaceDir.replace(/\/$/, "")}/${target.path}`
}

/**
 * File-path href of a timeline markdown anchor, or undefined for genuine web
 * links. The markdown renderer marks EVERY link target="_blank" — including
 * scheme-less local paths like `[README.md](/Users/…/README.md)`, which the
 * browser resolves against the app origin and opens as a dead new tab. Links
 * with a scheme, protocol-relative links, and in-page anchors keep their
 * browser behavior.
 */
export function timelineAnchorFileHref(anchor: Element): string | undefined {
  const href = anchor.getAttribute("href") ?? ""
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//") || href.startsWith("#")) return undefined
  try {
    return decodeURIComponent(href)
  } catch {
    return href
  }
}

/**
 * File href of the anchor a plain left-click targets, or undefined for
 * modifier/middle clicks and non-file anchors. Used by the capture-phase
 * handler so it can preventDefault before the browser's target="_blank"
 * new-window default action runs.
 */
export function timelineAnchorClickTarget(event: MouseEvent): string | undefined {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return undefined
  const target = event.target instanceof Element ? event.target : null
  const anchor = target?.closest("a[href]")
  return anchor ? timelineAnchorFileHref(anchor) : undefined
}

const IMAGE_URL_PATH = /(?:\.|\/)(?:avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i

/** External image or source-attachment URL targeted by a plain left-click. */
export function timelineExternalSourceClickTarget(event: MouseEvent): string | undefined {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return undefined
  const target = event.target instanceof Element ? event.target : null
  const anchor = target?.closest("a[href]")
  if (!anchor) return undefined
  const href = anchor.getAttribute("href")
  if (!href) return undefined
  try {
    const url = new URL(href)
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
    if (
      !target?.closest("img") &&
      !anchor.matches('[data-slot="file-part-link"]') &&
      !IMAGE_URL_PATH.test(url.pathname)
    ) return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

/**
 * Resolve the file path a context-menu event targets. Inline-code chips carry
 * the path as their text; filename slots render only the basename — there the
 * full path travels on a `data-path` attribute set at the render sites.
 * (Falling back to slot textContent used to fabricate
 * `<workspaceDir>/<basename>` paths for Open/Copy/Reveal.)
 */
export function timelineFileTarget(target: EventTarget | null): string | undefined {
  const el = target instanceof Element ? target : null
  const chip = el?.closest('[data-inline-code-kind="path"]')
  if (chip) {
    const text = chip.textContent?.trim()
    return text || undefined
  }
  const slot =
    el?.closest('[data-slot="message-part-title-filename"]') ??
    el?.closest('[data-slot="session-turn-diff-filename"]')
  if (!slot) return undefined
  return slot.closest("[data-path]")?.getAttribute("data-path") || undefined
}
