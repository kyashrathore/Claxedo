import {
  resolveWorkspaceFileFocus,
  type WorkspaceFileFocusTarget,
} from "@/lib/workspace-file-focus"

export const stripMentionSigil = (raw: string) => raw.trim().replace(/^@/, "")

export function timelineFileFocus(
  raw: string,
  workspaceDir: string,
): WorkspaceFileFocusTarget | undefined {
  return resolveWorkspaceFileFocus(stripMentionSigil(raw), workspaceDir)
}

export async function timelineFileCandidateIsOpenable(
  raw: string,
  workspaceDir: string,
  findFiles: (query: string) => Promise<readonly string[]>,
) {
  const target = timelineFileFocus(raw, workspaceDir)
  if (!target) return false
  return exactTimelineFileMatch(target.path, workspaceDir, findFiles)
}

async function exactTimelineFileMatch(
  path: string,
  workspaceDir: string,
  findFiles: (query: string) => Promise<readonly string[]>,
) {
  return (await findFiles(path)).some((file) => timelineFileFocus(file, workspaceDir)?.path === path)
}

export function resolveTimelinePath(raw: string, workspaceDir: string): string {
  const target = timelineFileFocus(raw, workspaceDir)
  if (!target) return timelineAbsoluteFilePath(raw) ?? stripMentionSigil(raw)
  return `${workspaceDir.replace(/\/$/, "")}/${target.path}`
}

export function timelineAbsoluteFilePath(raw: string): string | undefined {
  const path = stripMentionSigil(raw).replace(/:(\d+)(?::(\d+))?$/, "")
  return path.startsWith("/") && !path.startsWith("//") ? path : undefined
}

export function timelineAnchorFileHref(anchor: Element): string | undefined {
  if (anchor.hasAttribute("data-subagent-key")) return undefined
  const href = anchor.getAttribute("href") ?? ""
  if (!href || href.startsWith("//") || href.startsWith("#") || href.startsWith("?")) return undefined
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    if (!URL.canParse(href)) return undefined
    const url = new URL(href)
    if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost")) return undefined
    return decodedTimelinePath(url.pathname)
  }
  return decodedTimelinePath(href)
}

function decodedTimelinePath(href: string): string {
  try {
    return decodeURIComponent(href)
  } catch (error) {
    console.warn("A link's path could not be decoded; it opens as written", { href, error })
    return href
  }
}

export function timelineAnchorClickTarget(event: MouseEvent): string | undefined {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return undefined
  const selection = window.getSelection()
  if (selection && !selection.isCollapsed) return undefined
  const target = event.target instanceof Element ? event.target : null
  if (target?.closest('[data-component="markdown-image-tile"]')) return undefined
  const anchor = target?.closest("a[href]")
  return anchor ? timelineAnchorFileHref(anchor) : undefined
}

const IMAGE_URL_PATH = /(?:\.|\/)(?:avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i

export function timelineExternalSourceClickTarget(event: MouseEvent): string | undefined {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return undefined
  const selection = window.getSelection()
  if (selection && !selection.isCollapsed) return undefined
  const target = event.target instanceof Element ? event.target : null
  if (target?.closest('[data-component="markdown-image-tile"]')) return undefined
  const anchor = target?.closest("a[href]")
  if (!anchor) return undefined
  const href = anchor.getAttribute("href")
  if (!href) return undefined
  if (!URL.canParse(href)) return undefined
  const url = new URL(href)
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
  if (
    !target?.closest("img") &&
    !anchor.matches('[data-slot="file-part-link"]') &&
    !IMAGE_URL_PATH.test(url.pathname)
  ) return undefined
  return url.toString()
}

export function timelineFileTarget(target: EventTarget | null): string | undefined {
  const el = target instanceof Element ? target : null
  const anchor = el?.closest("a[href]")
  if (anchor) return timelineAnchorFileHref(anchor)
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
